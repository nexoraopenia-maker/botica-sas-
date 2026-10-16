import "server-only";
import { withTenant, type TenantDbContext } from "@/lib/db";

/** Producto tal como lo necesita la caja (serializable: decimales como string). */
export interface PosProduct {
  id: string;
  sku: string;
  barcode: string | null;
  name: string;
  dci: string | null;
  unitCode: string;
  salePrice: string;
  packagePrice: string | null;
  unitsPerPackage: number;
  packageUnitCode: string | null;
  allowFractional: boolean;
  igvAffectation: string;
  requiresRx: boolean;
  isService: boolean;
  tracksBatches: boolean;
  /** Stock vendible en unidad base (sin vencidos ni cuarentena) */
  available: string;
  nearestExpiry: string | null;
  withdrawalDays: number | null;
}

export interface PosContext {
  branchId: string;
  branchName: string;
  series: { BOLETA: string | null; FACTURA: string | null };
  products: PosProduct[];
}

/** Catálogo completo de la sucursal para búsqueda/escaneo instantáneo en el navegador (hasta 3000 productos). */
export async function loadPosContext(ctx: TenantDbContext & { branchIds: string[] }): Promise<PosContext | null> {
  return withTenant(ctx, async (tx) => {
    const branch = await tx.branch.findFirst({
      where: { is_active: true, deleted_at: null, ...(ctx.branchIds.length ? { id: { in: ctx.branchIds } } : {}) },
      orderBy: { sunat_code: "asc" },
    });
    if (!branch) return null;
    const series = await tx.documentSeries.findMany({
      where: { branch_id: branch.id, is_active: true, doc_type: { in: ["BOLETA", "FACTURA"] } },
      orderBy: { series: "asc" },
    });
    const products = await tx.$queryRaw<PosProduct[]>`
      SELECT p.id, p.sku, p.barcode, p.name, p.dci, p.unit_code AS "unitCode", p.sale_price::text AS "salePrice",
             p.package_price::text AS "packagePrice", p.units_per_package AS "unitsPerPackage",
             p.package_unit_code AS "packageUnitCode", p.allow_fractional AS "allowFractional",
             p.igv_affectation AS "igvAffectation",
             (p.is_controlled OR coalesce(p.sale_condition::text, 'FREE') <> 'FREE') AS "requiresRx",
             p.is_service AS "isService", p.tracks_batches AS "tracksBatches",
             coalesce(sum(b.stock), 0)::text AS available,
             to_char(min(b.expiry_date), 'YYYY-MM-DD') AS "nearestExpiry",
             greatest(p.withdrawal_days_meat, p.withdrawal_days_milk) AS "withdrawalDays"
        FROM products p
        LEFT JOIN product_batches b
               ON b.product_id = p.id AND b.branch_id = ${branch.id}::uuid AND b.stock > 0 AND b.deleted_at IS NULL
              AND NOT b.is_quarantined AND (b.expiry_date IS NULL OR b.expiry_date >= app.lima_today())
       WHERE p.deleted_at IS NULL AND p.is_active
       GROUP BY p.id
       ORDER BY p.name
       LIMIT 3000`;
    return {
      branchId: branch.id,
      branchName: branch.name,
      series: {
        BOLETA: series.find((s) => s.doc_type === "BOLETA")?.series ?? null,
        FACTURA: series.find((s) => s.doc_type === "FACTURA")?.series ?? null,
      },
      products,
    };
  });
}
