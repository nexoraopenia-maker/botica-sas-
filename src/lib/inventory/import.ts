import "server-only";
import { withTenant, type TenantDbContext } from "@/lib/db";
import { audit } from "@/lib/audit";
import { D } from "@/lib/money";
import type { Prisma } from "@/generated/prisma/client";
import type { ImportIssue, ImportRow } from "@/lib/inventory/import-format";

export interface ImportChange { line: number; sku: string; action: "create" | "update" | "same"; fields: string[] }

export interface ImportSummary {
  creates: number;
  updates: number;
  unchanged: number;
  /** Categorías que no existían y se crean (o reactivan) al aplicar */
  newCategories: string[];
  errors: ImportIssue[];
  /** Primeras filas con su efecto, para revisar antes de aplicar */
  changes: ImportChange[];
  notes: string[];
  applied: boolean;
}

const PREVIEW_ROWS = 300;
/** Comparable: sin tildes, mayúsculas ni espacios repetidos. «Analgésicos » y «analgesicos» son la misma categoría. */
const categoryKey = (s: string): string => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Crea y actualiza productos por SKU. Una celda vacía no modifica el producto existente. Las categorías inexistentes se crean.
 * Con `apply: false` solo calcula el efecto: es el mismo código que aplica, así que la vista previa no puede diferir del resultado.
 * Todo o nada: si una fila tiene error no se aplica nada.
 */
export async function importProducts(
  ctx: TenantDbContext,
  rows: ImportRow[],
  caps: { modules: ReadonlySet<string> },
  opts: { apply: boolean },
): Promise<ImportSummary> {
  const pharmacy = caps.modules.has("PHARMACY");
  return withTenant(ctx, async (tx) => {
    if (opts.apply) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`product-import:${ctx.tenantId}`}, 0))`;

    const skus = rows.map((r) => r.sku);
    const barcodes = rows.map((r) => r.barcode).filter((b): b is string => !!b);
    const [found, barcodeOwners, categories] = await Promise.all([
      tx.product.findMany({ where: { sku: { in: skus }, deleted_at: null } }),
      barcodes.length ? tx.product.findMany({ where: { barcode: { in: barcodes }, deleted_at: null }, select: { sku: true, barcode: true } }) : [],
      tx.productCategory.findMany({ select: { id: true, name: true, deleted_at: true } }),
    ]);
    const bySku = new Map(found.map((p) => [p.sku, p]));
    const barcodeOwner = new Map(barcodeOwners.map((p) => [p.barcode!, p.sku]));
    const categoryByKey = new Map(categories.map((c) => [categoryKey(c.name), c]));

    const errors: ImportIssue[] = [];
    const changes: ImportChange[] = [];
    const newCategoryNames = new Map<string, string>(); // clave → nombre tal como se escribió la primera vez
    const reviveNames = new Map<string, string>(); // categorías eliminadas que se reactivan (nombre guardado)
    const creates: { data: Prisma.ProductCreateManyInput; pendingCategory?: string }[] = [];
    const updates: { id: string; data: Prisma.ProductUncheckedUpdateManyInput; categoryKey?: string }[] = [];
    let unchanged = 0, ignoredPharmacy = 0;

    for (const row of rows) {
      const fail = (message: string) => errors.push({ line: row.line, message });
      const owner = row.barcode ? barcodeOwner.get(row.barcode) : undefined;
      if (owner && owner !== row.sku) { fail(`El código de barras ${row.barcode} ya pertenece al producto ${owner}.`); continue; }

      const pharmaFields = row.dci !== undefined || row.therapeuticAction !== undefined || row.kind !== undefined;
      if (pharmaFields && !pharmacy) ignoredPharmacy++;
      const usePharma = pharmacy;

      let categoryId: string | undefined;
      let pendingCategory: string | undefined;
      if (row.category) {
        const key = categoryKey(row.category);
        const existing = categoryByKey.get(key);
        if (existing && !existing.deleted_at) categoryId = existing.id;
        else {
          pendingCategory = key;
          if (existing) reviveNames.set(key, existing.name);
          else if (!newCategoryNames.has(key)) newCategoryNames.set(key, row.category);
        }
      }

      const current = bySku.get(row.sku);
      if (!current) {
        if (!row.name || row.salePrice === undefined) { fail(`El SKU ${row.sku} no existe: para crearlo indique Nombre y Precio de venta.`); continue; }
        const fields = ["nombre", "precio"];
        const data: Prisma.ProductCreateManyInput = {
          tenant_id: ctx.tenantId, sku: row.sku, name: row.name, sale_price: row.salePrice, unit_code: "NIU", igv_affectation: "10",
          tracks_batches: true, barcode: row.barcode ?? null, icbper: row.icbper ?? false, category_id: categoryId ?? null,
          ...(usePharma ? { dci: row.dci ?? null, therapeutic_action: row.therapeuticAction ?? null, pharmaceutical_kind: row.kind ?? null, sale_condition: "FREE" as const } : {}),
        };
        if (row.barcode) fields.push("código de barras");
        if (row.category) fields.push("categoría");
        if (usePharma && row.dci) fields.push("principio activo");
        if (usePharma && row.therapeuticAction) fields.push("acción terapéutica");
        if (usePharma && row.kind) fields.push("marca/genérico");
        if (row.icbper) fields.push("ICBPER");
        creates.push({ data, pendingCategory });
        changes.push({ line: row.line, sku: row.sku, action: "create", fields });
        continue;
      }

      if (row.icbper && current.is_service) { fail(`El SKU ${row.sku} es un servicio: no puede ser una bolsa con ICBPER.`); continue; }
      const data: Prisma.ProductUncheckedUpdateManyInput = {};
      const fields: string[] = [];
      if (row.name !== undefined && row.name !== current.name) { data.name = row.name; fields.push("nombre"); }
      if (row.salePrice !== undefined && !D(row.salePrice).eq(current.sale_price)) { data.sale_price = row.salePrice; fields.push("precio"); }
      if (row.barcode !== undefined && row.barcode !== current.barcode) { data.barcode = row.barcode; fields.push("código de barras"); }
      if (row.category && (pendingCategory || categoryId !== current.category_id)) { if (categoryId) data.category_id = categoryId; fields.push("categoría"); }
      if (usePharma) {
        if (row.dci !== undefined && row.dci !== current.dci) { data.dci = row.dci; fields.push("principio activo"); }
        if (row.therapeuticAction !== undefined && row.therapeuticAction !== current.therapeutic_action) { data.therapeutic_action = row.therapeuticAction; fields.push("acción terapéutica"); }
        if (row.kind !== undefined && row.kind !== current.pharmaceutical_kind) { data.pharmaceutical_kind = row.kind; fields.push("marca/genérico"); }
      }
      if (row.icbper !== undefined && row.icbper !== current.icbper) { data.icbper = row.icbper; fields.push("ICBPER"); }

      if (fields.length === 0) { unchanged++; changes.push({ line: row.line, sku: row.sku, action: "same", fields }); continue; }
      updates.push({ id: current.id, data, categoryKey: pendingCategory });
      changes.push({ line: row.line, sku: row.sku, action: "update", fields });
    }

    const notes: string[] = [];
    if (ignoredPharmacy > 0) notes.push(`Se ignoraron Principio Activo, Acción Terapéutica y Marca/Genérico en ${ignoredPharmacy} fila${ignoredPharmacy === 1 ? "" : "s"}: el módulo Farmacia no está activo.`);
    const newCategories = [...newCategoryNames.values(), ...reviveNames.values()].sort((a, b) => a.localeCompare(b, "es"));
    const summary: ImportSummary = {
      creates: creates.length, updates: updates.length, unchanged, newCategories, errors, notes, applied: false,
      // Primero lo que cambia: lo que ya estaba igual va al final
      changes: [...changes.filter((c) => c.action !== "same"), ...changes.filter((c) => c.action === "same")].slice(0, PREVIEW_ROWS),
    };
    if (!opts.apply || errors.length > 0) return summary;

    // Categorías primero (upsert como al crear un producto: la carrera con otra pestaña no duplica)
    const ids = new Map<string, string>();
    for (const [key, name] of [...newCategoryNames, ...reviveNames]) {
      const cat = await tx.productCategory.upsert({
        where: { tenant_id_name: { tenant_id: ctx.tenantId, name } },
        create: { tenant_id: ctx.tenantId, name },
        update: { deleted_at: null },
      });
      ids.set(key, cat.id);
    }
    const toCreate = creates.map((c) => (c.pendingCategory ? { ...c.data, category_id: ids.get(c.pendingCategory)! } : c.data));
    if (toCreate.length) await tx.product.createMany({ data: toCreate });
    // Las filas que cambian lo mismo (ej. asignar una categoría a cientos de productos) van en una sola sentencia
    const groups = new Map<string, { data: Prisma.ProductUncheckedUpdateManyInput; ids: string[] }>();
    for (const u of updates) {
      const data = u.categoryKey ? { ...u.data, category_id: ids.get(u.categoryKey)! } : u.data;
      const key = JSON.stringify(data);
      const g = groups.get(key) ?? { data, ids: [] };
      g.ids.push(u.id);
      groups.set(key, g);
    }
    for (const g of groups.values()) await tx.product.updateMany({ where: { id: { in: g.ids } }, data: g.data });

    await audit(tx, {
      tenantId: ctx.tenantId, actorUserId: ctx.userId, actorKind: "tenant_user", action: "product.import",
      entityType: "tenant", entityId: ctx.tenantId,
      after: { creates: summary.creates, updates: summary.updates, unchanged, newCategories },
    });
    return { ...summary, applied: true };
  }, { timeoutMs: opts.apply ? 50_000 : 20_000 });
}
