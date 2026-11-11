import "server-only";
import { Prisma, withTenant, type TenantDbContext } from "@/lib/db";

export interface InventoryRow {
  id: string; sku: string; name: string; dci: string | null; category_id: string | null; kind: string | null; sale_price: string; units_per_package: number; units_per_blister: number;
  min_stock: string; is_controlled: boolean; controlled_list: string | null; book_balance: string | null; total_stock: string; withdrawal: number | null; available: string; expired: string; nearest_expiry: Date | null; batches: number;
}

export interface InventoryList { rows: InventoryRow[]; noCategory: number; noKind: number }

/**
 * Productos con su stock, y cuántos tienen datos incompletos: sin categoría o, en una botica, un medicamento
 * (con principio activo) sin tipo Marca/Genérico. Con `onlyIncomplete` la lista trae solo esos.
 */
export async function loadInventoryList(ctx: TenantDbContext, opts: { pharmacy: boolean; onlyIncomplete: boolean }): Promise<InventoryList> {
  const { pharmacy, onlyIncomplete } = opts;
  const incompleteSql = Prisma.sql`(p.category_id IS NULL OR (${pharmacy}::boolean AND p.dci IS NOT NULL AND p.pharmaceutical_kind IS NULL))`;
  const [rows, [gaps]] = await withTenant(ctx, async (tx) => Promise.all([tx.$queryRaw<InventoryRow[]>`
    SELECT p.id, p.sku, p.name, p.dci, p.category_id, p.pharmaceutical_kind::text AS kind, p.sale_price::text, p.units_per_package, p.units_per_blister, p.min_stock::text, p.is_controlled, p.controlled_list,
           CASE WHEN p.is_controlled THEN (
             SELECT sum(x.balance)::text FROM (
               SELECT DISTINCT ON (l.branch_id) l.balance FROM controlled_substance_log l WHERE l.product_id = p.id ORDER BY l.branch_id, l.id DESC
             ) x) END AS book_balance,
           coalesce(sum(b.stock), 0)::text AS total_stock,
           greatest(p.withdrawal_days_meat, p.withdrawal_days_milk) AS withdrawal,
           coalesce(sum(b.stock) FILTER (WHERE b.expiry_date IS NULL OR b.expiry_date >= app.lima_today()), 0)::text AS available,
           coalesce(sum(b.stock) FILTER (WHERE b.expiry_date < app.lima_today()), 0)::text AS expired,
           min(b.expiry_date) FILTER (WHERE b.stock > 0 AND b.expiry_date >= app.lima_today()) AS nearest_expiry,
           count(b.id) FILTER (WHERE b.stock > 0)::int AS batches
      FROM products p LEFT JOIN product_batches b ON b.product_id = p.id AND b.deleted_at IS NULL
     WHERE p.deleted_at IS NULL AND p.is_active AND (${onlyIncomplete ? Prisma.sql`NOT p.is_service AND ${incompleteSql}` : Prisma.sql`true`})
     GROUP BY p.id ORDER BY p.name LIMIT 500`,
    tx.$queryRaw<{ no_category: number; no_kind: number }[]>`
    SELECT count(*) FILTER (WHERE p.category_id IS NULL)::int AS no_category,
           count(*) FILTER (WHERE ${pharmacy}::boolean AND p.dci IS NOT NULL AND p.pharmaceutical_kind IS NULL)::int AS no_kind
      FROM products p WHERE p.deleted_at IS NULL AND p.is_active AND NOT p.is_service`,
  ]));
  return { rows, noCategory: gaps?.no_category ?? 0, noKind: gaps?.no_kind ?? 0 };
}
