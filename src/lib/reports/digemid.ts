import "server-only";
import { withTenant, type TenantDbContext } from "@/lib/db";
import { audit } from "@/lib/audit";
import { D } from "@/lib/money";
import { DomainError } from "@/lib/result";
import type { ControlledRow, ObservatoryRow, PriceStockRow } from "./digemid-format";

export interface PriceReport {
  branches: { id: string; name: string; code: string | null }[];
  products: { id: string; name: string; sku: string; code: string | null; packagePrice: string; unitPrice: string; unitsPerPackage: number }[];
}

/** Productos farmacéuticos (con DCI, registro o condición de venta) y sus precios vigentes con IGV. */
export async function loadPriceReport(ctx: TenantDbContext & { branchIds: string[] }): Promise<PriceReport> {
  return withTenant(ctx, async (tx) => {
    const [branches, products] = await Promise.all([
      tx.branch.findMany({ where: { is_active: true, deleted_at: null, ...(ctx.branchIds.length ? { id: { in: ctx.branchIds } } : {}) }, orderBy: { sunat_code: "asc" } }),
      tx.product.findMany({
        where: { deleted_at: null, is_active: true, is_service: false, OR: [{ digemid_product_code: { not: null } }, { digemid_registration: { not: null } }, { dci: { not: null } }, { sale_condition: { not: null } }] },
        orderBy: { name: "asc" }, take: 5000,
      }),
    ]);
    return {
      branches: branches.map((b) => ({ id: b.id, name: b.name, code: b.digemid_establishment_code })),
      products: products.map((p) => ({
        id: p.id, name: p.name, sku: p.sku, code: p.digemid_product_code, unitsPerPackage: p.units_per_package,
        // Sin empaque propio, el empaque es la unidad
        packagePrice: (p.package_price ?? p.sale_price.times(p.units_per_package)).toFixed(2),
        unitPrice: p.sale_price.toFixed(2),
      })),
    };
  });
}

export async function observatoryRows(ctx: TenantDbContext, branchId: string): Promise<ObservatoryRow[]> {
  return withTenant(ctx, async (tx) => {
    const branch = await tx.branch.findFirst({ where: { id: branchId, deleted_at: null } });
    if (!branch) throw new DomainError("NOT_FOUND", "Sucursal no encontrada.");
    if (!branch.digemid_establishment_code) throw new DomainError("NO_ESTABLISHMENT_CODE", "Registre el código de establecimiento de la sucursal.");
    const products = await tx.product.findMany({ where: { deleted_at: null, is_active: true, digemid_product_code: { not: null } }, orderBy: { digemid_product_code: "asc" } });
    await audit(tx, {
      tenantId: ctx.tenantId, actorUserId: ctx.userId, actorKind: "tenant_user", action: "digemid.prices_export",
      entityType: "branch", entityId: branchId, after: { products: products.length },
    });
    return products.map((p) => ({
      establishment: branch.digemid_establishment_code!, productCode: p.digemid_product_code!,
      packagePrice: (p.package_price ?? p.sale_price.times(p.units_per_package)).toFixed(2), unitPrice: D(p.sale_price).toFixed(2),
    }));
  });
}

interface PriceStockRaw { code: string | null; sku: string; name: string; dci: string | null; sale_price: string; package_price: string | null; units_per_package: number; stock: string }

/** Productos farmacéuticos con su precio vigente y el stock vendible (sin vencidos ni cuarentena) de la sucursal. */
export async function loadPriceStockRows(ctx: TenantDbContext, branchId: string): Promise<PriceStockRow[]> {
  return withTenant(ctx, async (tx) => {
    const branch = await tx.branch.findFirst({ where: { id: branchId, deleted_at: null } });
    if (!branch) throw new DomainError("NOT_FOUND", "Sucursal no encontrada.");
    const rows = await tx.$queryRaw<PriceStockRaw[]>`
      SELECT p.digemid_product_code AS code, p.sku, p.name, p.dci, p.sale_price::text, p.package_price::text, p.units_per_package,
             coalesce(sum(b.stock) FILTER (WHERE b.expiry_date IS NULL OR b.expiry_date >= app.lima_today()), 0)::text AS stock
        FROM products p
        LEFT JOIN product_batches b ON b.product_id = p.id AND b.branch_id = ${branchId}::uuid AND b.stock > 0 AND b.deleted_at IS NULL AND NOT b.is_quarantined
       WHERE p.deleted_at IS NULL AND p.is_active AND NOT p.is_service
         AND (p.digemid_product_code IS NOT NULL OR p.digemid_registration IS NOT NULL OR p.dci IS NOT NULL OR p.sale_condition::text IN ('PRESCRIPTION', 'RETAINED_PRESCRIPTION'))
       GROUP BY p.id
       ORDER BY p.digemid_product_code NULLS LAST, p.name
       LIMIT 5000`;
    await audit(tx, {
      tenantId: ctx.tenantId, actorUserId: ctx.userId, actorKind: "tenant_user", action: "digemid.price_stock_export",
      entityType: "branch", entityId: branchId, after: { products: rows.length },
    });
    return rows.map((r) => ({
      productCode: r.code, sku: r.sku, product: r.name, dci: r.dci, unitPrice: D(r.sale_price).toFixed(2), stock: D(r.stock).toString(),
      packagePrice: (r.package_price ? D(r.package_price) : D(r.sale_price).times(r.units_per_package)).toFixed(2),
    }));
  });
}

interface RawRow {
  occurred_at: Date; product: string; dci: string | null; list: string | null; lot: string | null; expiry: Date | null; movement: string; quantity: string; balance: string;
  document: string | null; purchase: string | null; rx_kind: string | null; rx_date: Date | null; patient: string | null; prescriber: string | null; cmp: string | null; prescriber_doc: string | null;
  counterparty: string | null; recorded_by: string | null;
}

const iso = (d: Date | null) => d?.toISOString().slice(0, 10) ?? null;

/** Movimientos del libro de controlados por lote y receta, del periodo indicado (fechas de Lima). */
export async function loadControlledReport(ctx: TenantDbContext, from: string, to: string, opts: { audited?: boolean } = {}): Promise<ControlledRow[]> {
  return withTenant(ctx, async (tx) => {
    const rows = await tx.$queryRaw<RawRow[]>`
      SELECT l.occurred_at, p.name AS product, p.dci, p.controlled_list AS list, b.lot_code AS lot, b.expiry_date AS expiry, l.movement::text, l.quantity::text, l.balance::text,
             CASE WHEN d.id IS NOT NULL THEN d.series || '-' || d.number END AS document,
             CASE WHEN c.id IS NOT NULL THEN c.series || '-' || c.number END AS purchase,
             r.kind::text AS rx_kind, r.issued_at AS rx_date, r.patient_name AS patient, r.prescriber_name AS prescriber, r.prescriber_cmp AS cmp, r.prescriber_doc,
             l.counterparty, coalesce(u.full_name, u.email) AS recorded_by
        FROM controlled_substance_log l
        JOIN products p ON p.id = l.product_id
        LEFT JOIN product_batches b ON b.id = l.batch_id
        LEFT JOIN documents d ON d.id = l.document_id
        LEFT JOIN purchases c ON c.id = l.purchase_id
        LEFT JOIN prescriptions r ON r.id = l.prescription_id
        LEFT JOIN users u ON u.id = l.recorded_by
       WHERE l.occurred_at >= (${from}::date)::timestamp AT TIME ZONE 'America/Lima'
         AND l.occurred_at <  (${to}::date + 1)::timestamp AT TIME ZONE 'America/Lima'
       ORDER BY l.occurred_at DESC, l.id DESC
       LIMIT 10000`;
    if (opts.audited) {
      await audit(tx, {
        tenantId: ctx.tenantId, actorUserId: ctx.userId, actorKind: "tenant_user", action: "digemid.controlled_export",
        entityType: "tenant", entityId: ctx.tenantId, after: { from, to, rows: rows.length },
      });
    }
    return rows.map((r) => ({
      occurredAt: r.occurred_at.toLocaleString("es-PE", { timeZone: "America/Lima" }), product: r.product, dci: r.dci, list: r.list, lot: r.lot, expiry: iso(r.expiry),
      movement: r.movement === "IN" ? "Ingreso" : r.movement === "OUT" ? "Salida" : "Ajuste", quantity: r.quantity, balance: r.balance, document: r.document, purchase: r.purchase,
      rxKind: r.rx_kind, rxDate: iso(r.rx_date), patient: r.patient, prescriber: r.prescriber, prescriberCmp: r.cmp, prescriberDoc: r.prescriber_doc, counterparty: r.counterparty, recordedBy: r.recorded_by,
    }));
  });
}

export async function saveEstablishmentCode(ctx: TenantDbContext, branchId: string, code: string): Promise<void> {
  const value = code.trim().toUpperCase();
  if (!/^[A-Z0-9]{1,20}$/.test(value)) throw new DomainError("VALIDATION", "Código de establecimiento inválido.");
  await withTenant(ctx, async (tx) => {
    const res = await tx.branch.updateMany({ where: { id: branchId, deleted_at: null }, data: { digemid_establishment_code: value } });
    if (res.count === 0) throw new DomainError("NOT_FOUND", "Sucursal no encontrada.");
    await audit(tx, { tenantId: ctx.tenantId, actorUserId: ctx.userId, actorKind: "tenant_user", action: "digemid.establishment_code", entityType: "branch", entityId: branchId, after: { code: value } });
  });
}

export async function saveProductCode(ctx: TenantDbContext, productId: string, code: string): Promise<void> {
  const value = code.trim();
  if (value && !/^\d{1,20}$/.test(value)) throw new DomainError("VALIDATION", "El código del catálogo DIGEMID solo lleva números.");
  await withTenant(ctx, async (tx) => {
    const res = await tx.product.updateMany({ where: { id: productId, deleted_at: null }, data: { digemid_product_code: value || null } });
    if (res.count === 0) throw new DomainError("NOT_FOUND", "Producto no encontrado.");
    await audit(tx, { tenantId: ctx.tenantId, actorUserId: ctx.userId, actorKind: "tenant_user", action: "digemid.product_code", entityType: "product", entityId: productId, after: { code: value || null } });
  });
}
