import "server-only";
import { Prisma, withTenant, type TenantDbContext } from "@/lib/db";

/** Buckets de app.v_batch_expiry que se consideran críticos: vencidos y hasta 30 días (el límite es inclusivo, como el aviso de la caja). */
export const CRITICAL_BUCKETS = ["EXPIRED", "D7", "D15", "D30"] as const;

export interface ExpiryRow {
  batch_id: string; branch_id: string; product_name: string; sku: string; lot_code: string; expiry_date: Date; stock: string; stock_value: string;
  days_to_expiry: number; bucket: string; is_controlled: boolean;
}
export interface WasteRow { id: string; created_at: Date; product: string; lot: string | null; quantity: string; value: string; note: string | null; user: string | null }
export interface ExpiryOverview {
  rows: ExpiryRow[];
  /** Lotes y valor (costo) del stock vencido y del que vence en ≤ 30 días */
  expired: { lots: number; value: string };
  critical: { lots: number; value: string };
  recentWaste: WasteRow[];
  /** Costo de lo dado de baja por merma en los últimos 30 días */
  wasteValue30d: string;
}

const branchSql = (alias: string, branchIds: readonly string[]) => (branchIds.length ? Prisma.sql`AND ${Prisma.raw(alias)}.branch_id = ANY(${[...branchIds]}::uuid[])` : Prisma.empty);

/** Cantidad de lotes críticos (vencidos o a ≤ 30 días con stock): el número que ve el dueño en Inventario. */
export async function criticalLotCount(ctx: TenantDbContext, branchIds: readonly string[]): Promise<number> {
  return withTenant(ctx, async (tx) => {
    const [r] = await tx.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM app.v_batch_expiry v
       WHERE v.bucket IN ('EXPIRED', 'D7', 'D15', 'D30') ${branchSql("v", branchIds)}`;
    return r?.n ?? 0;
  });
}

/** `view`: "criticos" = vencidos y ≤ 30 días; "todos" = hasta 90 días. */
export async function loadExpiryOverview(ctx: TenantDbContext, branchIds: readonly string[], view: "criticos" | "todos"): Promise<ExpiryOverview> {
  return withTenant(ctx, async (tx) => {
    const bucketFilter = view === "criticos" ? Prisma.sql`v.bucket IN ('EXPIRED', 'D7', 'D15', 'D30')` : Prisma.sql`v.bucket <> 'OK'`;
    const [rows, [sums], recentWaste, [waste]] = await Promise.all([
      tx.$queryRaw<ExpiryRow[]>`
        SELECT v.batch_id, v.branch_id, v.product_name, v.sku, v.lot_code, v.expiry_date, v.stock::text, v.stock_value::text, v.days_to_expiry, v.bucket, p.is_controlled
          FROM app.v_batch_expiry v JOIN products p ON p.id = v.product_id
         WHERE ${bucketFilter} ${branchSql("v", branchIds)}
         ORDER BY v.expiry_date, v.product_name LIMIT 500`,
      tx.$queryRaw<{ expired_lots: number; expired_value: string; critical_lots: number; critical_value: string }[]>`
        SELECT count(*) FILTER (WHERE v.bucket = 'EXPIRED')::int AS expired_lots,
               coalesce(sum(v.stock_value) FILTER (WHERE v.bucket = 'EXPIRED'), 0)::text AS expired_value,
               count(*) FILTER (WHERE v.bucket IN ('D7', 'D15', 'D30'))::int AS critical_lots,
               coalesce(sum(v.stock_value) FILTER (WHERE v.bucket IN ('D7', 'D15', 'D30')), 0)::text AS critical_value
          FROM app.v_batch_expiry v WHERE true ${branchSql("v", branchIds)}`,
      tx.$queryRaw<WasteRow[]>`
        SELECT m.id::text AS id, m.created_at, p.name AS product, b.lot_code AS lot, abs(m.quantity)::text AS quantity,
               round(abs(m.quantity) * coalesce(m.unit_cost, 0), 2)::text AS value, m.note, coalesce(u.full_name, u.email) AS "user"
          FROM stock_movements m JOIN products p ON p.id = m.product_id
          LEFT JOIN product_batches b ON b.id = m.batch_id LEFT JOIN users u ON u.id = m.created_by
         WHERE m.type = 'WASTE' AND m.created_at >= now() - interval '30 days' ${branchSql("m", branchIds)}
         ORDER BY m.created_at DESC, m.id DESC LIMIT 50`,
      tx.$queryRaw<{ value: string }[]>`
        SELECT coalesce(sum(round(abs(m.quantity) * coalesce(m.unit_cost, 0), 2)), 0)::text AS value
          FROM stock_movements m WHERE m.type = 'WASTE' AND m.created_at >= now() - interval '30 days' ${branchSql("m", branchIds)}`,
    ]);
    return {
      rows,
      expired: { lots: sums?.expired_lots ?? 0, value: sums?.expired_value ?? "0" },
      critical: { lots: sums?.critical_lots ?? 0, value: sums?.critical_value ?? "0" },
      recentWaste,
      wasteValue30d: waste?.value ?? "0",
    };
  });
}
