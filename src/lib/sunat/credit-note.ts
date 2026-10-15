import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { withTenant, type TenantDbContext } from "@/lib/db";
import { D, round2 } from "@/lib/money";
import { DomainError } from "@/lib/result";
import { audit } from "@/lib/audit";
import { limaNow } from "@/lib/time";
import { CREDIT_NOTE_REASONS, RESTOCKING_CREDIT_REASONS, type CreditNoteReason, type IgvAffectation } from "@/lib/sunat/catalogs";
import { computeLine, computeTotals } from "@/lib/sunat/totals";
import { validateDocumentRules } from "@/lib/sunat/validation";

export const creditNoteSchema = z.object({
  idempotencyKey: z.uuid(),
  documentId: z.uuid(),
  series: z.string().regex(/^[FB][A-Z0-9]{3}$/),
  reasonCode: z.enum(Object.keys(CREDIT_NOTE_REASONS) as [CreditNoteReason, ...CreditNoteReason[]]),
  reasonText: z.string().trim().min(5).max(250),
  /** Vacío = nota por el total del comprobante */
  lines: z.array(z.object({ itemId: z.uuid(), quantity: z.union([z.number(), z.string()]).transform((v) => D(v)) })).default([]),
});

/**
 * Nota de crédito. Para devoluciones/anulación (01, 06, 07) repone stock a los
 * MISMOS lotes que se vendieron (document_item_lots), en orden inverso al FEFO.
 */
export async function issueCreditNote(ctx: TenantDbContext, raw: z.input<typeof creditNoteSchema>): Promise<{ documentId: string; series: string; number: number }> {
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

    // Cantidades ya acreditadas por NC previas (no se puede devolver dos veces)
    const prior = await tx.$queryRaw<{ product_id: string; qty: string }[]>`
      SELECT di.product_id, sum(di.base_quantity)::text AS qty
        FROM documents d JOIN document_items di ON di.document_id = d.id
       WHERE d.ref_document_id = ${ref.id}::uuid AND d.doc_type = 'NOTA_CREDITO' AND d.status <> 'RECHAZADO'
       GROUP BY di.product_id`;
    const credited = new Map(prior.map((p) => [p.product_id, D(p.qty)]));

    const selected = input.lines.length
      ? input.lines.map((l) => {
          const it = ref.items.find((i) => i.id === l.itemId);
          if (!it) throw new DomainError("INVALID_LINE", "Línea no pertenece al comprobante.");
          if (l.quantity.lte(0) || l.quantity.gt(it.quantity)) throw new DomainError("INVALID_QTY", `Cantidad inválida para ${it.description}.`);
          return { it, qty: l.quantity };
        })
      : ref.items.map((it) => ({ it, qty: it.quantity }));

    const lines = selected.map(({ it, qty }) => {
      const ratio = qty.div(it.quantity);
      const baseQty = it.base_quantity.times(ratio);
      const already = it.product_id ? (credited.get(it.product_id) ?? D(0)) : D(0);
      if (it.product_id && already.plus(baseQty).gt(it.base_quantity)) {
        throw new DomainError("OVER_CREDIT", `${it.description}: ya se acreditó ${already.toString()} de ${it.base_quantity.toString()}.`);
      }
      const totals = computeLine({
        quantity: qty,
        unitPrice: it.unit_price,
        affectation: it.igv_affectation as IgvAffectation,
        discount: it.discount.gt(0) ? round2(it.discount.times("1.18").times(ratio)) : 0,
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
        .flatMap((l) => l.it.lots.map((lot) => ({ batchId: lot.batch_id, qty: lot.quantity.times(l.ratio).toDecimalPlaces(3) })))
        .filter((r) => r.qty.gt(0))
        .sort((a, b) => a.batchId.localeCompare(b.batchId));
      for (const r of restocks) {
        await tx.$executeRaw`SELECT app.restock_batch(${ctx.tenantId}::uuid, ${r.batchId}::uuid, ${r.qty}::numeric,
          'SALE_RETURN'::"StockMovementType", 'document', ${noteId}::uuid, ${ctx.userId}::uuid)`;
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
      },
    });
    await tx.documentItem.createMany({
      data: lines.map((l, i) => ({
        tenant_id: ctx.tenantId, document_id: noteId, line_no: i + 1, product_id: l.it.product_id, description: l.it.description,
        unit_code: l.it.unit_code, sale_unit: l.it.sale_unit, quantity: l.qty, base_quantity: l.baseQty,
        unit_value: l.totals.unitValue, unit_price: l.totals.unitPrice, discount: l.totals.discount,
        igv_affectation: l.totals.affectation, igv_base: l.totals.igvBase, igv_amount: l.totals.igv,
        line_extension: l.totals.lineExtension, line_total: l.totals.lineTotal,
      })),
    });
    await tx.outboxEvent.create({
      data: {
        tenant_id: ctx.tenantId, aggregate_type: "document", aggregate_id: noteId, event_type: "document.issued",
        payload: { documentId: noteId }, dedupe_key: `document.issued:${noteId}`,
      },
    });
    await audit(tx, {
      tenantId: ctx.tenantId, actorUserId: ctx.userId, actorKind: "tenant_user", action: "document.credit_note",
      entityType: "document", entityId: ref.id, reason: input.reasonText,
      after: { note: `${input.series}-${number}`, reason: input.reasonCode, total: totals.total.toFixed(2) },
    });
    return { documentId: noteId, series: input.series, number };
  });
}
