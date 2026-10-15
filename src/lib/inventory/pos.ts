import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Prisma, withTenant, type TenantDbContext, type Tx } from "@/lib/db";
import { D, type Decimal, round2, sum } from "@/lib/money";
import { DomainError } from "@/lib/result";
import { limaNow } from "@/lib/time";
import { IGV_AFFECTATIONS, type IgvAffectation } from "@/lib/sunat/catalogs";
import { computeLine, computeTotals, type LineTotals } from "@/lib/sunat/totals";
import { validateDocumentRules } from "@/lib/sunat/validation";
import { resolveSaleUnit } from "@/lib/pharmacy/fractioning";
import { assertPrescriptionValid, requiresPrescription } from "@/lib/pharmacy/prescription-rules";

// ───────────────────────────── Entrada ─────────────────────────────

const money = z.union([z.number(), z.string()]).transform((v) => D(v)).refine((d) => d.gte(0), "Debe ser ≥ 0");

export const saleItemSchema = z.object({
  productId: z.uuid(),
  saleUnit: z.enum(["UNIT", "PACKAGE"]).default("UNIT"),
  quantity: z.union([z.number(), z.string()]).transform((v) => D(v)).refine((d) => d.gt(0), "Cantidad > 0"),
  /** Solo con permiso pos.discount: precio manual IGV incluido */
  unitPriceOverride: money.optional(),
  discount: money.optional(),
  /** Bonificación / muestra gratuita: 11 (gravado) o 21 (exonerado) */
  freeAffectation: z.enum(["11", "21", "31"]).optional(),
  prescriptionId: z.uuid().optional(),
  preferredBatchId: z.uuid().optional(),
  icbperUnits: z.number().int().min(0).max(1000).optional(),
});

export const createSaleSchema = z
  .object({
    idempotencyKey: z.uuid(),
    branchId: z.uuid(),
    docType: z.enum(["FACTURA", "BOLETA"]),
    series: z.string().regex(/^[FB][A-Z0-9]{3}$/),
    customer: z.object({
      docType: z.enum(["NO_DOC", "DNI", "CE", "RUC", "PASSPORT"]),
      docNumber: z.string().trim().max(15).default("-"),
      name: z.string().trim().min(1).max(200),
      address: z.string().trim().max(250).optional(),
      email: z.email().optional(),
    }),
    items: z.array(saleItemSchema).min(1).max(300),
    payments: z
      .array(z.object({
        method: z.enum(["EFECTIVO", "YAPE", "PLIN", "TARJETA", "TRANSFERENCIA", "CREDITO"]),
        amount: money,
        reference: z.string().max(60).optional(),
      }))
      .max(5),
    paymentTerms: z.enum(["Contado", "Credito"]).default("Contado"),
    dueDate: z.iso.date().optional(),
    medicalRecordId: z.uuid().optional(),
  })
  .refine((v) => v.docType !== "FACTURA" || v.series.startsWith("F"), { message: "Serie de factura debe iniciar con F", path: ["series"] })
  .refine((v) => v.docType !== "BOLETA" || v.series.startsWith("B"), { message: "Serie de boleta debe iniciar con B", path: ["series"] });

export type CreateSaleInput = z.input<typeof createSaleSchema>;

export interface SaleResult {
  documentId: string;
  series: string;
  number: number;
  total: string;
  igv: string;
  issueDate: string;
  replayed: boolean;
  warnings: string[];
}

export interface SellerCapabilities {
  canOverridePrice: boolean;
  canDispenseRx: boolean;
  pharmacyEnabled: boolean;
}

// ───────────────────────────── Errores SQL → dominio ─────────────────────────────

function mapDbError(err: unknown): never {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes("Stock insuficiente")) {
    throw new DomainError("INSUFFICIENT_STOCK", "Stock insuficiente (lotes vencidos o en cuarentena no se venden).");
  }
  if (msg.includes("lock timeout") || msg.includes("55P03") || msg.includes("deadlock")) {
    throw new DomainError("BUSY_RETRY", "Caja ocupada, reintentando… (operación segura de repetir)");
  }
  if (msg.includes("Serie") && msg.includes("no existe")) {
    throw new DomainError("SERIES_NOT_FOUND", "La serie seleccionada no está activa.");
  }
  throw err;
}

// ───────────────────────────── Venta ─────────────────────────────

interface FefoAllocation {
  batch_id: string;
  quantity: Prisma.Decimal;
  unit_cost: Prisma.Decimal;
}

/**
 * Venta de mostrador atómica.
 *
 * Orden de bloqueos (idéntico en todas las transacciones → sin deadlocks):
 *   1. Lotes, producto por producto en orden de product_id, FEFO (FOR UPDATE en app.consume_stock_fefo)
 *   2. Serie del comprobante (UPDATE ... RETURNING en app.next_document_number) — al final,
 *      para que el lock más disputado (correlativo) se mantenga el menor tiempo posible.
 * lock_timeout corto: ante contención se falla rápido y el POS reintenta con la misma
 * idempotencyKey (sin duplicar venta ni descontar dos veces).
 * El contador de uso del plan NO se actualiza aquí (sería un hot-row por tenant).
 */
export async function createSale(ctx: TenantDbContext, rawInput: CreateSaleInput, caps: SellerCapabilities): Promise<SaleResult> {
  const input = createSaleSchema.parse(rawInput);
  const now = limaNow();

  try {
    return await withTenant(ctx, async (tx) => {
      await tx.$executeRaw`SET LOCAL lock_timeout = '3s'`;
      await tx.$executeRaw`SET LOCAL statement_timeout = '10s'`;

      // 0) Idempotencia
      const existing = await tx.document.findFirst({ where: { idempotency_key: input.idempotencyKey } });
      if (existing) return replay(existing);

      // 1) Catálogo (RLS garantiza que solo se vean productos del tenant)
      const productIds = [...new Set(input.items.map((i) => i.productId))];
      const products = await tx.product.findMany({ where: { id: { in: productIds }, deleted_at: null, is_active: true } });
      const byId = new Map(products.map((p) => [p.id, p]));
      const missing = productIds.filter((id) => !byId.has(id));
      if (missing.length) throw new DomainError("PRODUCT_NOT_FOUND", "Uno o más productos no existen o están inactivos.");

      const rxIds = input.items.map((i) => i.prescriptionId).filter((x): x is string => !!x);
      const prescriptions = rxIds.length ? await tx.prescription.findMany({ where: { id: { in: rxIds } } }) : [];
      const rxById = new Map(prescriptions.map((r) => [r.id, r]));

      // 2) Líneas y totales (puro, sin locks)
      const warnings: string[] = [];
      const lines = input.items.map((item, idx) => {
        const p = byId.get(item.productId)!;
        const unit = resolveSaleUnit(p, item.saleUnit, item.quantity);
        if (item.unitPriceOverride && !caps.canOverridePrice) {
          throw new DomainError("FORBIDDEN", "No tiene permiso para modificar precios.");
        }
        if (item.discount?.gt(0) && !caps.canOverridePrice) {
          throw new DomainError("FORBIDDEN", "No tiene permiso para aplicar descuentos.");
        }
        if (requiresPrescription(p)) {
          if (!caps.pharmacyEnabled) throw new DomainError("MODULE_DISABLED", `${p.name} requiere el módulo Farmacia.`);
          if (!caps.canDispenseRx) throw new DomainError("RX_PHARMACIST_ONLY", `${p.name} solo puede dispensarlo el químico farmacéutico.`);
          assertPrescriptionValid(p, item.prescriptionId ? rxById.get(item.prescriptionId) : undefined, now.dateObj);
        }
        if (p.withdrawal_days_meat || p.withdrawal_days_milk) {
          warnings.push(
            `${p.name}: periodo de retiro carne ${p.withdrawal_days_meat ?? 0} d / leche ${p.withdrawal_days_milk ?? 0} d (informar al productor).`,
          );
        }
        const affectation: IgvAffectation = item.freeAffectation ?? (IGV_AFFECTATIONS.includes(p.igv_affectation as IgvAffectation)
          ? (p.igv_affectation as IgvAffectation)
          : "10");
        const totals = computeLine({
          quantity: item.quantity,
          unitPrice: item.unitPriceOverride ?? unit.unitPrice,
          affectation,
          discount: item.discount ?? 0,
          icbperUnits: item.icbperUnits ?? (p.icbper ? item.quantity.toNumber() : 0),
        });
        return { idx, item, product: p, unit, totals };
      });

      const totals = computeTotals(lines.map((l) => l.totals));

      // 3) Reglas SUNAT
      const issues = validateDocumentRules({
        docType: input.docType,
        series: input.series,
        issueDate: now.dateObj,
        today: now.dateObj,
        total: totals.total,
        customerDocType: input.customer.docType,
        customerDocNumber: input.customer.docNumber,
        customerName: input.customer.name,
        paymentTerms: input.paymentTerms,
        dueDate: input.dueDate ? new Date(`${input.dueDate}T00:00:00Z`) : null,
      });
      if (issues.length) throw new DomainError(issues[0]!.code, issues.map((i) => i.message).join(" · "));

      // 4) Pagos
      const paid = sum(input.payments.map((p) => p.amount));
      if (input.paymentTerms === "Contado" && !round2(paid).eq(round2(totals.total))) {
        throw new DomainError("PAYMENT_MISMATCH", `Pagos (S/ ${paid.toFixed(2)}) no cuadran con el total (S/ ${totals.total.toFixed(2)}).`);
      }

      // 5) Cliente (upsert sobre índice único parcial)
      const customerId = await upsertCustomer(tx, ctx.tenantId, input.customer);

      // 6) Stock FEFO — orden determinista por product_id
      const documentId = randomUUID();
      const allocations = new Map<number, FefoAllocation[]>();
      const ordered = [...lines].sort((a, b) => a.product.id.localeCompare(b.product.id) || a.idx - b.idx);
      for (const l of ordered) {
        if (!l.product.tracks_batches || l.product.is_service) continue;
        const rows = await tx.$queryRaw<FefoAllocation[]>`
          SELECT batch_id, quantity, unit_cost FROM app.consume_stock_fefo(
            ${ctx.tenantId}::uuid, ${input.branchId}::uuid, ${l.product.id}::uuid, ${l.unit.baseQuantity}::numeric,
            'SALE'::"StockMovementType", 'document', ${documentId}::uuid, ${ctx.userId}::uuid,
            ${l.item.preferredBatchId ?? null}::uuid)`;
        allocations.set(l.idx, rows);
      }

      // 7) Correlativo (último lock)
      const [{ n: number }] = await tx.$queryRaw<[{ n: number }]>`
        SELECT app.next_document_number(${ctx.tenantId}::uuid, ${input.docType}::"DocumentType", ${input.series}) AS n`;

      // 8) Persistencia
      await tx.document.create({
        data: {
          id: documentId,
          tenant_id: ctx.tenantId,
          branch_id: input.branchId,
          doc_type: input.docType,
          series: input.series,
          number,
          issue_date: now.dateObj,
          issue_time: now.time,
          due_date: input.dueDate ? new Date(`${input.dueDate}T00:00:00Z`) : null,
          payment_terms: input.paymentTerms,
          customer_id: customerId,
          customer_doc_type: input.customer.docType,
          customer_doc_number: input.customer.docType === "NO_DOC" ? "-" : input.customer.docNumber,
          customer_name: input.customer.name,
          customer_address: input.customer.address ?? null,
          op_gravadas: totals.opGravadas,
          op_exoneradas: totals.opExoneradas,
          op_inafectas: totals.opInafectas,
          op_gratuitas: totals.opGratuitas,
          total_discount: totals.totalDiscount,
          igv: totals.igv,
          icbper: totals.icbper,
          total: totals.total,
          idempotency_key: input.idempotencyKey,
          created_by: ctx.userId,
          status: "PENDIENTE",
        },
      });

      const itemIds = lines.map(() => randomUUID());
      await tx.documentItem.createMany({
        data: lines.map((l, i) => itemRow(ctx.tenantId, documentId, itemIds[i]!, i + 1, l.product, l.item.saleUnit, l.unit, l.totals, l.item.prescriptionId)),
      });

      const lotRows = lines.flatMap((l, i) =>
        (allocations.get(l.idx) ?? []).map((a) => ({
          tenant_id: ctx.tenantId, document_item_id: itemIds[i]!, batch_id: a.batch_id, quantity: a.quantity, unit_cost: a.unit_cost,
        })),
      );
      if (lotRows.length) await tx.documentItemLot.createMany({ data: lotRows });

      if (input.payments.length) {
        await tx.documentPayment.createMany({
          data: input.payments.map((p) => ({
            tenant_id: ctx.tenantId, document_id: documentId, method: p.method, amount: round2(p.amount), reference: p.reference ?? null,
          })),
        });
      }

      // Farmacia: libro de controlados (saldo por trigger) y cierre de recetas
      const controlled = lines.filter((l) => l.product.is_controlled);
      for (const l of controlled) {
        for (const a of allocations.get(l.idx) ?? []) {
          await tx.controlledSubstanceLog.create({
            data: {
              tenant_id: ctx.tenantId, branch_id: input.branchId, product_id: l.product.id, batch_id: a.batch_id,
              movement: "OUT", quantity: a.quantity, balance: 0, document_id: documentId,
              prescription_id: l.item.prescriptionId ?? null, counterparty: input.customer.name, recorded_by: ctx.userId,
            },
          });
        }
      }
      if (rxIds.length) {
        await tx.prescription.updateMany({ where: { id: { in: rxIds } }, data: { dispensed_at: new Date() } });
      }

      if (input.medicalRecordId) {
        await tx.medicalRecord.update({ where: { id: input.medicalRecordId }, data: { document_id: documentId } });
      }

      // 9) Outbox: envío a SUNAT fuera de la transacción (patrón Outbox)
      await tx.outboxEvent.create({
        data: {
          tenant_id: ctx.tenantId,
          aggregate_type: "document",
          aggregate_id: documentId,
          event_type: "document.issued",
          payload: { documentId },
          dedupe_key: `document.issued:${documentId}`,
        },
      });

      return {
        documentId,
        series: input.series,
        number,
        total: totals.total.toFixed(2),
        igv: totals.igv.toFixed(2),
        issueDate: now.date,
        replayed: false,
        warnings,
      };
    });
  } catch (err) {
    if (err instanceof DomainError) throw err;
    // Carrera de idempotencia: otra request con la misma clave ganó → devolver esa venta
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const target = JSON.stringify(err.meta ?? {});
      if (target.includes("idempotency_key")) {
        const doc = await withTenant(ctx, (tx) => tx.document.findFirst({ where: { idempotency_key: input.idempotencyKey } }));
        if (doc) return replay(doc);
      }
    }
    mapDbError(err);
  }
}

function replay(doc: { id: string; series: string; number: number; total: Decimal; igv: Decimal; issue_date: Date }): SaleResult {
  return {
    documentId: doc.id,
    series: doc.series,
    number: doc.number,
    total: doc.total.toFixed(2),
    igv: doc.igv.toFixed(2),
    issueDate: doc.issue_date.toISOString().slice(0, 10),
    replayed: true,
    warnings: [],
  };
}

function itemRow(
  tenantId: string,
  documentId: string,
  id: string,
  lineNo: number,
  p: { id: string; name: string },
  saleUnit: "UNIT" | "PACKAGE",
  unit: { baseQuantity: Decimal; unitCode: string },
  t: LineTotals,
  prescriptionId: string | undefined,
): Prisma.DocumentItemCreateManyInput {
  return {
    id,
    tenant_id: tenantId,
    document_id: documentId,
    line_no: lineNo,
    product_id: p.id,
    description: p.name,
    unit_code: unit.unitCode,
    sale_unit: saleUnit,
    quantity: t.quantity,
    base_quantity: unit.baseQuantity,
    unit_value: t.unitValue,
    unit_price: t.unitPrice,
    discount: t.discount,
    igv_affectation: t.affectation,
    igv_base: t.igvBase,
    igv_amount: t.igv,
    line_extension: t.lineExtension,
    line_total: t.lineTotal,
    icbper_units: t.icbper.gt(0) ? t.icbper.div("0.50").toNumber() : 0,
    icbper_amount: t.icbper,
    prescription_id: prescriptionId ?? null,
  };
}

async function upsertCustomer(
  tx: Tx,
  tenantId: string,
  c: { docType: "NO_DOC" | "DNI" | "CE" | "RUC" | "PASSPORT"; docNumber: string; name: string; address?: string | undefined; email?: string | undefined },
): Promise<string | null> {
  if (c.docType === "NO_DOC") return null;
  const rows = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO customers (tenant_id, doc_type, doc_number, name, address, email)
    VALUES (${tenantId}::uuid, ${c.docType}::"IdentityDocType", ${c.docNumber}, ${c.name}, ${c.address ?? null}, ${c.email ?? null})
    ON CONFLICT (tenant_id, doc_type, doc_number) WHERE deleted_at IS NULL AND doc_type <> 'NO_DOC'
    DO UPDATE SET name = EXCLUDED.name,
                  address = coalesce(EXCLUDED.address, customers.address),
                  email = coalesce(EXCLUDED.email, customers.email)
    RETURNING id`;
  return rows[0]?.id ?? null;
}
