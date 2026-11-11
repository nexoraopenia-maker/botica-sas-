import "server-only";
import { withTenant, type TenantDbContext } from "@/lib/db";
import { limaNow } from "@/lib/time";

/** Producto tal como lo necesita la caja (serializable: decimales como string). */
export interface PosProduct {
  id: string;
  sku: string;
  barcode: string | null;
  name: string;
  dci: string | null;
  concentration: string | null;
  pharmaceuticalForm: string | null;
  laboratory: string | null;
  therapeuticAction: string | null;
  pharmaceuticalKind: "GENERIC" | "BRAND" | null;
  /** Bolsa plástica: cada unidad paga ICBPER */
  icbper: boolean;
  categoryId: string | null;
  categoryName: string | null;
  unitCode: string;
  salePrice: string;
  packagePrice: string | null;
  unitsPerPackage: number;
  unitsPerBlister: number;
  blisterPrice: string | null;
  baseUnitName: string | null;
  packageUnitCode: string | null;
  allowFractional: boolean;
  igvAffectation: string;
  requiresRx: boolean;
  isService: boolean;
  tracksBatches: boolean;
  /** Stock vendible en unidad base (sin vencidos ni cuarentena) */
  available: string;
  nearestExpiry: string | null;
  /** Stock que no se puede vender porque su lote venció */
  expiredStock: string;
  withdrawalDays: number | null;
  withdrawalMeat: number | null;
  withdrawalMilk: number | null;
  isControlled: boolean;
  /** Tipo de receta que exige el producto (null = venta libre) */
  rxKind: "SIMPLE" | "RETAINED" | "SPECIAL" | null;
}

export interface PosContext {
  branchId: string;
  branchName: string;
  series: { BOLETA: string | null; FACTURA: string | null };
  products: PosProduct[];
  today: string;
  /** Usuarios del negocio que pueden vender */
  sellers: { id: string; name: string }[];
  loyaltyEnabled: boolean;
}

/** Catálogo completo de la sucursal para búsqueda/escaneo instantáneo en el navegador (hasta 3000 productos). */
/** La sucursal en la que opera la caja del usuario. */
export function findActiveBranch(tx: Parameters<Parameters<typeof withTenant>[1]>[0], branchIds: string[]) {
  return tx.branch.findFirst({
    where: { is_active: true, deleted_at: null, ...(branchIds.length ? { id: { in: branchIds } } : {}) },
    orderBy: { sunat_code: "asc" },
  });
}

export async function loadPosContext(ctx: TenantDbContext & { branchIds: string[] }): Promise<PosContext | null> {
  return withTenant(ctx, async (tx) => {
    const branch = await findActiveBranch(tx, ctx.branchIds);
    if (!branch) return null;
    const series = await tx.documentSeries.findMany({
      where: { branch_id: branch.id, is_active: true, doc_type: { in: ["BOLETA", "FACTURA"] } },
      orderBy: { series: "asc" },
    });
    const products = await tx.$queryRaw<PosProduct[]>`
      SELECT p.id, p.sku, p.barcode, p.name, p.dci, p.concentration, p.pharmaceutical_form AS "pharmaceuticalForm", p.laboratory,
             p.therapeutic_action AS "therapeuticAction", p.pharmaceutical_kind::text AS "pharmaceuticalKind", p.icbper, p.category_id AS "categoryId",
             (SELECT c.name FROM product_categories c WHERE c.id = p.category_id AND c.deleted_at IS NULL) AS "categoryName", p.unit_code AS "unitCode", p.sale_price::text AS "salePrice",
             p.package_price::text AS "packagePrice", p.units_per_package AS "unitsPerPackage",
             p.units_per_blister AS "unitsPerBlister", p.blister_price::text AS "blisterPrice", p.base_unit_name AS "baseUnitName",
             p.package_unit_code AS "packageUnitCode", p.allow_fractional AS "allowFractional",
             p.igv_affectation AS "igvAffectation",
             (p.is_controlled OR coalesce(p.sale_condition::text, '') IN ('PRESCRIPTION', 'RETAINED_PRESCRIPTION')) AS "requiresRx",
             p.is_service AS "isService", p.tracks_batches AS "tracksBatches",
             coalesce(sum(b.stock) FILTER (WHERE b.expiry_date IS NULL OR b.expiry_date >= app.lima_today()), 0)::text AS available,
             to_char(min(b.expiry_date) FILTER (WHERE b.expiry_date IS NULL OR b.expiry_date >= app.lima_today()), 'YYYY-MM-DD') AS "nearestExpiry",
             coalesce(sum(b.stock) FILTER (WHERE b.expiry_date < app.lima_today()), 0)::text AS "expiredStock",
             greatest(p.withdrawal_days_meat, p.withdrawal_days_milk) AS "withdrawalDays",
             p.withdrawal_days_meat AS "withdrawalMeat", p.withdrawal_days_milk AS "withdrawalMilk",
             p.is_controlled AS "isControlled",
             CASE WHEN p.is_controlled THEN 'SPECIAL'
                  WHEN p.sale_condition::text = 'RETAINED_PRESCRIPTION' THEN 'RETAINED'
                  WHEN p.sale_condition::text = 'PRESCRIPTION' THEN 'SIMPLE' END AS "rxKind"
        FROM products p
        LEFT JOIN product_batches b
               ON b.product_id = p.id AND b.branch_id = ${branch.id}::uuid AND b.stock > 0 AND b.deleted_at IS NULL AND NOT b.is_quarantined
       WHERE p.deleted_at IS NULL AND p.is_active
       GROUP BY p.id
       ORDER BY p.name
       LIMIT 3000`;
    const members = await tx.tenantUser.findMany({ where: { status: "ACTIVE", deleted_at: null }, include: { role: { select: { permissions: true } }, user: { select: { full_name: true, email: true } } } });
    const loyalty = await tx.loyaltySettings.findUnique({ where: { tenant_id: ctx.tenantId }, select: { enabled: true } });
    return {
      today: limaNow().date,
      sellers: members
        .filter((m) => m.role.permissions.includes("*") || m.role.permissions.includes("pos.sell"))
        .map((m) => ({ id: m.user_id, name: m.user.full_name ?? m.user.email }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      loyaltyEnabled: !!loyalty?.enabled,
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
