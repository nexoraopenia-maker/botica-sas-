import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { withTenant, type TenantDbContext } from "@/lib/db";
import { audit } from "@/lib/audit";
import { D } from "@/lib/money";
import { DomainError } from "@/lib/result";
import { limaNow } from "@/lib/time";
import { CLOSURE_METHODS, computeClosure, type ClosureMethod, type ClosureResult } from "./cash-closure-calc";

export interface CashSummary {
  from: string;
  to: string;
  documents: number;
  /** Vendido por medio de pago arqueable (sin fondo inicial) */
  sales: Record<ClosureMethod, string>;
  /** Devuelto a clientes con notas de crédito en este turno: se descuenta del esperado */
  refunds: Record<ClosureMethod, string>;
  /** Transferencia, crédito…: informativo */
  others: { method: string; total: string }[];
}

interface PaymentRow { method: string; total: string; docs: number }

/** Inicio del turno: el último cierre de este cajero en la sucursal; si no hay, el inicio del día en Lima. */
async function periodStart(tx: Parameters<Parameters<typeof withTenant>[1]>[0], branchId: string, userId: string): Promise<Date> {
  const last = await tx.cashClosure.findFirst({ where: { branch_id: branchId, user_id: userId }, orderBy: { period_to: "desc" }, select: { period_to: true } });
  return last?.period_to ?? new Date(`${limaNow().date}T00:00:00-05:00`);
}

async function loadPayments(tx: Parameters<Parameters<typeof withTenant>[1]>[0], branchId: string, userId: string, from: Date, to: Date) {
  // Incluye comprobantes RECHAZADOS: el dinero se cobró y está en caja aunque SUNAT deba corregirse. Los anulados no.
  const rows = await tx.$queryRaw<PaymentRow[]>`
    SELECT p.method::text AS method, sum(p.amount)::text AS total, count(DISTINCT d.id)::int AS docs
      FROM document_payments p JOIN documents d ON d.id = p.document_id
     WHERE d.branch_id = ${branchId}::uuid AND d.created_by = ${userId}::uuid
       AND d.doc_type IN ('FACTURA', 'BOLETA') AND d.status <> 'ANULADO' AND d.deleted_at IS NULL
       AND d.created_at > ${from} AND d.created_at <= ${to}
     GROUP BY p.method`;
  const [count] = await tx.$queryRaw<{ c: number }[]>`
    SELECT count(*)::int AS c FROM documents d
     WHERE d.branch_id = ${branchId}::uuid AND d.created_by = ${userId}::uuid
       AND d.doc_type IN ('FACTURA', 'BOLETA') AND d.status <> 'ANULADO' AND d.deleted_at IS NULL
       AND d.created_at > ${from} AND d.created_at <= ${to}`;
  // Notas de crédito con devolución emitidas por este cajero. Una rechazada por SUNAT también cuenta: el dinero ya salió de caja
  const refundRows = await tx.$queryRaw<{ method: string; total: string }[]>`
    SELECT p.method::text AS method, sum(p.amount)::text AS total
      FROM document_payments p JOIN documents d ON d.id = p.document_id
     WHERE d.branch_id = ${branchId}::uuid AND d.created_by = ${userId}::uuid
       AND d.doc_type = 'NOTA_CREDITO' AND d.status <> 'ANULADO' AND d.deleted_at IS NULL
       AND d.created_at > ${from} AND d.created_at <= ${to}
     GROUP BY p.method`;
  const refunds = Object.fromEntries(CLOSURE_METHODS.map((m) => [m, refundRows.find((r) => r.method === m)?.total ?? "0.00"])) as Record<ClosureMethod, string>;
  const sales = Object.fromEntries(CLOSURE_METHODS.map((m) => [m, rows.find((r) => r.method === m)?.total ?? "0.00"])) as Record<ClosureMethod, string>;
  const others = rows.filter((r) => !CLOSURE_METHODS.includes(r.method as ClosureMethod)).map((r) => ({ method: r.method, total: r.total }));
  return { sales, refunds, others, documents: count?.c ?? 0 };
}

export async function getCashSummary(ctx: TenantDbContext, branchId: string): Promise<CashSummary> {
  return withTenant(ctx, async (tx) => {
    const from = await periodStart(tx, branchId, ctx.userId);
    const to = new Date();
    const p = await loadPayments(tx, branchId, ctx.userId, from, to);
    return { from: from.toISOString(), to: to.toISOString(), ...p };
  });
}

const amount = z.union([z.number(), z.string()]).transform((v) => D(String(v).replace(",", "."))).refine((d) => d.gte(0), "Debe ser un monto válido");

export const closeCashSchema = z.object({
  idempotencyKey: z.uuid(),
  branchId: z.uuid(),
  opening: amount,
  // Los cuatro medios son obligatorios: sin arqueo completo no hay cierre
  counted: z.object({ EFECTIVO: amount, YAPE: amount, PLIN: amount, TARJETA: amount }),
  notes: z.string().trim().max(500).optional(),
});

export async function closeCash(ctx: TenantDbContext, raw: z.input<typeof closeCashSchema>): Promise<ClosureResult & { closureId: string; replayed: boolean }> {
  const i = closeCashSchema.parse(raw);
  return withTenant(ctx, async (tx) => {
    // Un cierre a la vez por cajero y sucursal: dos pestañas no pueden arquear el mismo periodo
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`cash:${i.branchId}:${ctx.userId}`}, 0))`;
    const existing = await tx.cashClosure.findFirst({ where: { idempotency_key: i.idempotencyKey } });
    if (existing) {
      return {
        closureId: existing.id, replayed: true, lines: existing.breakdown as unknown as ClosureResult["lines"],
        expectedTotal: existing.expected_total.toFixed(2), countedTotal: existing.counted_total.toFixed(2), difference: existing.difference.toFixed(2),
      };
    }
    const from = await periodStart(tx, i.branchId, ctx.userId);
    const to = new Date();
    const p = await loadPayments(tx, i.branchId, ctx.userId, from, to);
    const result = computeClosure(i.opening, p.sales, i.counted, p.refunds);
    if (!D(result.difference).isZero() && !i.notes) {
      throw new DomainError("NOTES_REQUIRED", `Hay un descuadre de S/ ${result.difference}: explique el motivo en las observaciones.`);
    }
    const id = randomUUID();
    await tx.cashClosure.create({
      data: {
        id, tenant_id: ctx.tenantId, branch_id: i.branchId, user_id: ctx.userId, idempotency_key: i.idempotencyKey,
        period_from: from, period_to: to, opening_amount: i.opening.toFixed(2), breakdown: result.lines as unknown as object, other_methods: p.others,
        expected_total: result.expectedTotal, counted_total: result.countedTotal, difference: result.difference,
        document_count: p.documents, notes: i.notes ?? null,
      },
    });
    await audit(tx, {
      tenantId: ctx.tenantId, actorUserId: ctx.userId, actorKind: "tenant_user", action: "cash.close",
      entityType: "cash_closure", entityId: id, after: { expected: result.expectedTotal, counted: result.countedTotal, difference: result.difference },
    });
    return { closureId: id, replayed: false, ...result };
  });
}
