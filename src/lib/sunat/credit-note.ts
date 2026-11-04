import "server-only";
import { applyCreditNoteWallet } from "@/lib/loyalty/wallet";
import { findActiveBranch } from "@/lib/inventory/pos-catalog";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { withTenant, type TenantDbContext } from "@/lib/db";
import { D, round2, type Decimal } from "@/lib/money";
import { DomainError } from "@/lib/result";
import { audit } from "@/lib/audit";
import { limaNow } from "@/lib/time";
import { FULL_CREDIT_REASONS, RESTOCKING_CREDIT_REASONS, SUPPORTED_CREDIT_REASONS, type IgvAffectation } from "@/lib/sunat/catalogs";
import { computeLine, computeTotals } from "@/lib/sunat/totals";
import { validateDocumentRules } from "@/lib/sunat/validation";

export const creditNoteSchema = z.object({
  idempotencyKey: z.uuid(),
  documentId: z.uuid(),
  series: z.string().regex(/^[FB][A-Z0-9]{3}$/),
  reasonCode: z.enum(SUPPORTED_CREDIT_REASONS),
  reasonText: z.string().trim().min(5).max(250),
  /** Vacío = nota por el total del comprobante */
  lines: z.array(z.object({ itemId: z.uuid(), quantity: z.union([z.number(), z.string()]).transform((v) => D(v)) })).default([]),
  /** Cómo se devolvió el dinero al cliente. Vacío = sin devolución (ajuste, crédito a favor…): no afecta la caja */
  refundMethod: z.enum(["EFECTIVO", "YAPE", "PLIN", "TARJETA", "TRANSFERENCIA"]).optional(),
});

/**
 * Nota de crédito. Para devoluciones/anulación (01, 06, 07) repone stock a los
 * MISMOS lotes que se vendieron (document_item_lots), en orden inverso al FEFO.
 */
export async function issueCreditNote(ctx: TenantDbContext & { branchIds?: string[] }, raw: z.input<typeof creditNoteSchema>): Promise<{ documentId: string; series: string; number: number }> {
  const input = creditNoteSchema.parse(raw);
  const now = limaNow();

  return withTenant(ctx, async (tx) => {
    await tx.$executeRaw`SET LOCAL lock_timeout = '3s'`;
    const dup = await tx.document.findFirst({ where: { idempotency_key: input.idempotencyKey } });
    if (dup) return { documentId: dup.id, series: dup.series, number: dup.number };

    const ref = await tx.document.findFirst({
      where: { id: input.documentId },
      include: { items: { include: { lots: true }, orderBy: { line_no: "asc" } } },
    });
    if (!ref) throw new DomainError("NOT_FOUND", "Comprobante no encontrado.");
    if (ref.doc_type !== "FACTURA" && ref.doc_type !== "BOLETA") throw new DomainError("INVALID_REF", "Solo se emiten NC sobre facturas o boletas.");

    // Cantidades ya acreditadas por NC previas (no se puede devolver dos veces). Incluye las rechazadas por SUNAT:
    // esa nota ya repuso stock y movió dinero, y otra nota lo haría de nuevo.
    const prior = await tx.$queryRaw<{ product_id: string; qty: string }[]>`
      SELECT di.product_id, sum(di.base_quantity)::text AS qty
        FROM documents d JOIN document_items di ON di.document_id = d.id
       WHERE d.ref_document_id = ${ref.id}::uuid AND d.doc_type = 'NOTA_CREDITO'
       GROUP BY di.product_id`;
    const credited = new Map(prior.map((p) => [p.product_id, D(p.qty)]));

    const fullReason = FULL_CREDIT_REASONS.includes(input.reasonCode);
    if (fullReason && prior.length > 0) throw new DomainError("ALREADY_CREDITED", "El comprobante ya tiene una nota de crédito: use «Devolución por ítem» para lo que falta.");
    if (input.reasonCode === "02" && ref.doc_type !== "FACTURA") throw new DomainError("INVALID_REASON", "La anulación por error en el RUC solo aplica a facturas.");
    if (input.reasonCode === "07" && input.lines.length === 0) throw new DomainError("LINES_REQUIRED", "Indique qué productos se devuelven.");
    if (input.refundMethod && ref.payment_terms === "Credito") throw new DomainError("REFUND_ON_CREDIT", "La venta fue a crédito: no corresponde devolver dinero.");

    const selected = !fullReason
      ? input.lines.map((l) => {
          const it = ref.items.find((i) => i.id === l.itemId);
          if (!it) throw new DomainError("INVALID_LINE", "Línea no pertenece al comprobante.");
          if (l.quantity.lte(0) || l.quantity.gt(it.quantity)) throw new DomainError("INVALID_QTY", `Cantidad inválida para ${it.description}.`);
          return { it, qty: l.quantity };
        })
      : ref.items.map((it) => ({ it, qty: it.quantity }));

    if (new Set(selected.map((l) => l.it.id)).size !== selected.length) throw new DomainError("INVALID_LINE", "Hay una línea repetida.");
    const productIds = [...new Set(ref.items.map((i) => i.product_id).filter((x): x is string => !!x))];
    const products = new Map((await tx.product.findMany({ where: { id: { in: productIds } }, select: { id: true, allow_fractional: true, is_controlled: true } })).map((p) => [p.id, p]));
    // Tope por producto, no por línea: una venta puede tener el mismo producto en blíster y en caja
    const sold = new Map<string, Decimal>();
    for (const i of ref.items) if (i.product_id) sold.set(i.product_id, (sold.get(i.product_id) ?? D(0)).plus(i.base_quantity));
    const running = new Map(credited);

    const lines = selected.map(({ it, qty }) => {
      const ratio = qty.div(it.quantity);
      const baseQty = it.base_quantity.times(ratio);
      if (it.product_id) {
        if (!products.get(it.product_id)?.allow_fractional && !qty.isInteger()) throw new DomainError("INVALID_QTY", `${it.description} no admite cantidades fraccionadas.`);
        const total = (running.get(it.product_id) ?? D(0)).plus(baseQty);
        const limit = sold.get(it.product_id)!;
        if (total.gt(limit)) throw new DomainError("OVER_CREDIT", `${it.description}: se vendieron ${limit.toString()} y ya se acreditaron ${(running.get(it.product_id) ?? D(0)).toString()} (unidad base).`);
        running.set(it.product_id, total);
      }
      const totals = computeLine({
        quantity: qty,
        unitPrice: it.unit_price,
        affectation: it.igv_affectation as IgvAffectation,
        discount: it.discount.gt(0) ? round2(it.discount.times("1.18").times(ratio)) : 0,
        icbperUnits: it.icbper_units > 0 ? Math.round(it.icbper_units * ratio.toNumber()) : 0,
      });
      return { it, qty, baseQty, ratio, totals };
    });
    const totals = computeTotals(lines.map((l) => l.totals));

    const issues = validateDocumentRules({
      docType: "NOTA_CREDITO", series: input.series, issueDate: now.dateObj, today: now.dateObj, total: totals.total,
      customerDocType: ref.customer_doc_type, customerDocNumber: ref.customer_doc_number, customerName: ref.customer_name,
      paymentTerms: "Contado",
      reference: { docType: ref.doc_type, series: ref.series, status: ref.status, reasonCode: input.reasonCode, total: ref.total },
    });
    if (issues.length) throw new DomainError(issues[0]!.code, issues.map((i) => i.message).join(" · "));

    const noteId = randomUUID();
    // Reposición a los lotes originales (orden por id de lote → orden de locks determinista)
    if (RESTOCKING_CREDIT_REASONS.includes(input.reasonCode)) {
      const restocks = lines
        .flatMap((l) => l.it.lots.map((lot) => ({ batchId: lot.batch_id, productId: l.it.product_id, qty: lot.quantity.times(l.ratio).toDecimalPlaces(3) })))
        .filter((r) => r.qty.gt(0))
        .sort((a, b) => a.batchId.localeCompare(b.batchId));
      for (const r of restocks) {
        await tx.$executeRaw`SELECT app.restock_batch(${ctx.tenantId}::uuid, ${r.batchId}::uuid, ${r.qty}::numeric,
          'SALE_RETURN'::"StockMovementType", 'document', ${noteId}::uuid, ${ctx.userId}::uuid)`;
        // El libro de controlados debe registrar el reingreso: su saldo sigue al stock físico
        if (r.productId && products.get(r.productId)?.is_controlled) {
          await tx.controlledSubstanceLog.create({
            data: {
              tenant_id: ctx.tenantId, branch_id: ref.branch_id, product_id: r.productId, batch_id: r.batchId, movement: "IN", quantity: r.qty, balance: 0,
              document_id: noteId, counterparty: `Devolución de ${ref.customer_name}`, recorded_by: ctx.userId,
            },
          });
        }
      }
    }

    const [{ n: number }] = await tx.$queryRaw<[{ n: number }]>`
      SELECT app.next_document_number(${ctx.tenantId}::uuid, 'NOTA_CREDITO'::"DocumentType", ${input.series}) AS n`;

    await tx.document.create({
      data: {
        id: noteId, tenant_id: ctx.tenantId, branch_id: ref.branch_id, doc_type: "NOTA_CREDITO", series: input.series, number,
        issue_date: now.dateObj, issue_time: now.time, currency: ref.currency, customer_id: ref.customer_id,
        customer_doc_type: ref.customer_doc_type, customer_doc_number: ref.customer_doc_number,
        customer_name: ref.customer_name, customer_address: ref.customer_address,
        op_gravadas: totals.opGravadas, op_exoneradas: totals.opExoneradas, op_inafectas: totals.opInafectas,
        op_gratuitas: totals.opGratuitas, total_discount: totals.totalDiscount, igv: totals.igv, icbper: totals.icbper,
        total: totals.total, ref_document_id: ref.id, note_reason_code: input.reasonCode, note_reason_text: input.reasonText,
        idempotency_key: input.idempotencyKey, created_by: ctx.userId,
        seller_id: ref.seller_id, seller_commission_percent: ref.seller_commission_percent,
      },
    });
    await tx.documentItem.createMany({
      data: lines.map((l, i) => ({
        tenant_id: ctx.tenantId, document_id: noteId, line_no: i + 1, product_id: l.it.product_id, description: l.it.description,
        unit_code: l.it.unit_code, sale_unit: l.it.sale_unit, quantity: l.qty, base_quantity: l.baseQty,
        unit_value: l.totals.unitValue, unit_price: l.totals.unitPrice, discount: l.totals.discount,
        igv_affectation: l.totals.affectation, igv_base: l.totals.igvBase, igv_amount: l.totals.igv,
        line_extension: l.totals.lineExtension, line_total: l.totals.lineTotal,
        icbper_units: l.totals.icbper.gt(0) ? l.totals.icbper.div("0.50").toNumber() : 0, icbper_amount: l.totals.icbper,
      })),
    });
    const toWallet = await applyCreditNoteWallet(tx, ctx, { customerId: ref.customer_id, saleId: ref.id, noteId, noteTotal: totals.total, saleTotal: ref.total });
    // Lo que se pagó con monedero vuelve al monedero: solo se devuelve en dinero el resto
    const refundMoney = round2(totals.total.minus(toWallet));
    if (input.refundMethod && refundMoney.gt(0)) {
      // El comprobante pertenece a la sucursal de la venta, pero el dinero sale de la caja de quien emite
      const cashBranch = await findActiveBranch(tx, ctx.branchIds ?? []);
      await tx.documentPayment.create({ data: { tenant_id: ctx.tenantId, document_id: noteId, method: input.refundMethod, amount: refundMoney, cash_branch_id: cashBranch?.id ?? ref.branch_id } });
    }
    await tx.outboxEvent.create({
      data: {
        tenant_id: ctx.tenantId, aggregate_type: "document", aggregate_id: noteId, event_type: "document.issued",
        payload: { documentId: noteId }, dedupe_key: `document.issued:${noteId}`,
      },
    });
    await audit(tx, {
      tenantId: ctx.tenantId, actorUserId: ctx.userId, actorKind: "tenant_user", action: "document.credit_note",
      entityType: "document", entityId: ref.id, reason: input.reasonText,
      after: { note: `${input.series}-${number}`, reason: input.reasonCode, total: totals.total.toFixed(2), refund: input.refundMethod ?? null },
    });
    return { documentId: noteId, series: input.series, number };
  });
}

export interface CreditNoteLine { id: string; description: string; unitLabel: string; sold: string; remaining: string; unitPrice: string; lineTotal: string; fractional: boolean }

export interface CreditNoteContext {
  document: {
    id: string; label: string; docType: string; status: string; issueDate: string; customerName: string; customerDoc: string; total: string;
    paymentTerms: string; branchId: string;
  };
  lines: CreditNoteLine[];
  series: string[];
  payments: { method: string; amount: string }[];
  priorNotes: { label: string; total: string; status: string }[];
  /** Motivo por el que no se puede emitir, o null */
  blocker: string | null;
  fullyCredited: boolean;
  hasRejectedNote: boolean;
}

const UNIT_LABEL: Record<string, string> = { UNIT: "unidad", BLISTER: "blíster", PACKAGE: "caja" };

/** Datos para la pantalla de emisión: lo que aún se puede devolver y las series disponibles. */
export async function loadCreditNoteContext(ctx: TenantDbContext, documentId: string): Promise<CreditNoteContext | null> {
  return withTenant(ctx, async (tx) => {
    const ref = await tx.document.findFirst({
      where: { id: documentId, deleted_at: null },
      include: { items: { orderBy: { line_no: "asc" } }, payments: true, notes: { where: { doc_type: "NOTA_CREDITO" }, include: { items: true }, orderBy: { created_at: "asc" } } },
    });
    if (!ref) return null;
    const series = await tx.documentSeries.findMany({ where: { branch_id: ref.branch_id, doc_type: "NOTA_CREDITO", is_active: true, series: { startsWith: ref.series[0]! } }, orderBy: { series: "asc" } });
    const ids = [...new Set(ref.items.map((i) => i.product_id).filter((x): x is string => !!x))];
    const fractional = new Map((await tx.product.findMany({ where: { id: { in: ids } }, select: { id: true, allow_fractional: true } })).map((p) => [p.id, p.allow_fractional]));
    // Lo ya acreditado por producto se reparte entre sus líneas en orden: el servidor valida el tope por producto
    const pending = new Map<string, Decimal>();
    for (const n of ref.notes) for (const i of n.items) if (i.product_id) pending.set(i.product_id, (pending.get(i.product_id) ?? D(0)).plus(i.base_quantity));
    const lines = ref.items.map((it): CreditNoteLine => {
      const perUnit = it.base_quantity.div(it.quantity);
      const used = it.product_id ? minDecimal(pending.get(it.product_id) ?? D(0), it.base_quantity) : D(0);
      if (it.product_id) pending.set(it.product_id, (pending.get(it.product_id) ?? D(0)).minus(used));
      return {
        id: it.id, description: it.description, unitLabel: UNIT_LABEL[it.sale_unit] ?? "unidad", sold: it.quantity.toString(),
        remaining: it.base_quantity.minus(used).div(perUnit).toDecimalPlaces(3).toString(),
        unitPrice: it.unit_price.toFixed(2), lineTotal: it.line_total.toFixed(2), fractional: it.product_id ? !!fractional.get(it.product_id) : false,
      };
    });
    const fullyCredited = lines.every((l) => D(l.remaining).lte(0));
    const hasRejectedNote = ref.notes.some((n) => n.status === "RECHAZADO");
    const blocker = ref.doc_type !== "FACTURA" && ref.doc_type !== "BOLETA" ? "Solo se emiten notas de crédito sobre facturas y boletas."
      : !["ACEPTADO", "ACEPTADO_CON_OBS"].includes(ref.status) ? "El comprobante debe estar aceptado por SUNAT antes de emitir una nota de crédito."
      : fullyCredited ? "Este comprobante ya se acreditó por completo."
      : null;
    return {
      document: {
        id: ref.id, label: `${ref.series}-${ref.number}`, docType: ref.doc_type, status: ref.status, issueDate: ref.issue_date.toISOString().slice(0, 10),
        customerName: ref.customer_name, customerDoc: ref.customer_doc_type === "NO_DOC" ? "Sin documento" : ref.customer_doc_number, total: ref.total.toFixed(2),
        paymentTerms: ref.payment_terms, branchId: ref.branch_id,
      },
      lines,
      series: series.map((s) => s.series),
      payments: ref.payments.map((p) => ({ method: p.method, amount: p.amount.toFixed(2) })),
      priorNotes: ref.notes.map((n) => ({ label: `${n.series}-${n.number}`, total: n.total.toFixed(2), status: n.status })),
      blocker, fullyCredited, hasRejectedNote,
    };
  });
}

const minDecimal = (a: Decimal, b: Decimal): Decimal => (a.lt(b) ? a : b);
