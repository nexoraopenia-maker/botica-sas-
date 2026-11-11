/** Carga masiva de productos, catálogo de la caja por categoría y lista de Inventario contra PostgreSQL real con RLS. */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ImportRow } from "@/lib/inventory/import-format";

Object.assign(process.env, {
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgresql://x@localhost/x",
  PLATFORM_DATABASE_URL: process.env.TEST_PLATFORM_DATABASE_URL ?? "postgresql://x@localhost/x",
});

const T = randomUUID(), T2 = randomUUID(), B = randomUUID(), U = randomUUID();
const ctx = { tenantId: T, userId: U };
const farmacia = { modules: new Set(["PHARMACY"]) };
const retail = { modules: new Set(["RETAIL"]) };

describe("Carga masiva de productos (PostgreSQL)", async () => {
  const { platformDb, runtimeDb } = await import("@/lib/db");
  const { importProducts } = await import("@/lib/inventory/import");
  const { loadPosContext } = await import("@/lib/inventory/pos-catalog");
  const { loadInventoryList } = await import("@/lib/inventory/list");
  const db = platformDb();
  const ruc = () => `20${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`;
  let line = 1;
  const row = (sku: string, over: Partial<ImportRow> = {}): ImportRow => ({ line: ++line, sku, ...over });
  const product = (sku: string, tenant = T) => db.product.findFirstOrThrow({ where: { tenant_id: tenant, sku, deleted_at: null } });
  const categories = async (tenant = T) => (await db.productCategory.findMany({ where: { tenant_id: tenant }, orderBy: { name: "asc" } }));

  beforeAll(async () => {
    for (const id of [T, T2]) {
      await db.$executeRawUnsafe(`INSERT INTO tenants (id, slug, ruc, legal_name, business_lines, fiscal_address, ubigeo, department, province, district, contact_email, status)
        VALUES ('${id}', 'imp-${id.slice(0, 8)}', '${ruc()}', 'BOTICA TEST', '{PHARMACY}', 'Av 1', '150101', 'LIMA', 'LIMA', 'LIMA', 'b@t.pe', 'ACTIVE')`);
    }
    await db.$executeRawUnsafe(`INSERT INTO branches (id, tenant_id, sunat_code, name, address, ubigeo) VALUES ('${B}', '${T}', '0000', 'Principal', 'Av 1', '150101')`);
    await db.$executeRawUnsafe(`INSERT INTO users (id, email, full_name) VALUES ('${U}', '${U}@t.pe', 'Admin')`);
  });
  afterAll(async () => { await runtimeDb().$disconnect(); await db.$disconnect(); });

  it("la vista previa no guarda nada y aplicar crea y actualiza; repetir no cambia nada", async () => {
    await db.$executeRawUnsafe(`INSERT INTO products (tenant_id, sku, name, sale_price, dci) VALUES ('${T}', 'EXIST', 'Existente', 1, 'Ibuprofeno')`);
    const rows = [
      row("NUEVO", { name: "Producto nuevo", salePrice: "2.50", category: "Analgésicos", dci: "Paracetamol", therapeuticAction: "Analgésico", kind: "GENERIC", icbper: false }),
      row("EXIST", { category: "Analgésicos", kind: "BRAND" }),
    ];
    const preview = await importProducts(ctx, rows, farmacia, { apply: false });
    expect(preview).toMatchObject({ creates: 1, updates: 1, unchanged: 0, applied: false, errors: [], newCategories: ["Analgésicos"] });
    expect(preview.changes.map((c) => [c.sku, c.action])).toEqual([["NUEVO", "create"], ["EXIST", "update"]]);
    expect(await db.product.count({ where: { tenant_id: T, sku: "NUEVO" } })).toBe(0);
    expect(await categories()).toHaveLength(0);

    const done = await importProducts(ctx, rows, farmacia, { apply: true });
    expect(done).toMatchObject({ creates: 1, updates: 1, applied: true });
    const nuevo = await product("NUEVO");
    expect(nuevo).toMatchObject({ name: "Producto nuevo", dci: "Paracetamol", therapeutic_action: "Analgésico", pharmaceutical_kind: "GENERIC", icbper: false, unit_code: "NIU", igv_affectation: "10", tracks_batches: true, sale_condition: "FREE" });
    expect(nuevo.sale_price.toFixed(2)).toBe("2.50");
    const exist = await product("EXIST");
    expect(exist).toMatchObject({ pharmaceutical_kind: "BRAND", dci: "Ibuprofeno", name: "Existente" }); // lo que no vino no cambia
    expect(exist.category_id).toBe(nuevo.category_id);

    const again = await importProducts(ctx, rows, farmacia, { apply: true });
    expect(again).toMatchObject({ creates: 0, updates: 0, unchanged: 2, applied: true, newCategories: [] });
  });

  it("crea las categorías que faltan una sola vez, aunque se escriban distinto, y reutiliza las existentes", async () => {
    const rows = [
      row("CAT1", { name: "Uno", salePrice: "1", category: "Vitaminas y Suplementos" }),
      row("CAT2", { name: "Dos", salePrice: "1", category: "vitaminas y suplementos " }),
      row("CAT3", { name: "Tres", salePrice: "1", category: "VITAMINAS Y SUPLEMENTOS" }),
      row("CAT4", { name: "Cuatro", salePrice: "1", category: "analgesicos" }), // ya existe «Analgésicos», con tilde
    ];
    const r = await importProducts(ctx, rows, farmacia, { apply: true });
    expect(r.newCategories).toEqual(["Vitaminas y Suplementos"]);
    const cats = await categories();
    expect(cats.map((c) => c.name)).toEqual(["Analgésicos", "Vitaminas y Suplementos"]);
    const ids = await Promise.all(["CAT1", "CAT2", "CAT3"].map(async (s) => (await product(s)).category_id));
    expect(new Set(ids).size).toBe(1);
    expect((await product("CAT4")).category_id).toBe(cats[0]!.id);
  });

  it("reactiva una categoría eliminada en vez de duplicarla", async () => {
    await db.productCategory.create({ data: { tenant_id: T, name: "Dermatología", deleted_at: new Date() } });
    const r = await importProducts(ctx, [row("DER1", { name: "Crema", salePrice: "9", category: "dermatologia" })], farmacia, { apply: true });
    expect(r.newCategories).toEqual(["Dermatología"]);
    const cats = (await categories()).filter((c) => c.name === "Dermatología");
    expect(cats).toHaveLength(1);
    expect(cats[0]!.deleted_at).toBeNull();
    expect((await product("DER1")).category_id).toBe(cats[0]!.id);
  });

  it("una celda vacía no pisa el dato que ya tiene el producto", async () => {
    await db.$executeRawUnsafe(`INSERT INTO products (tenant_id, sku, name, sale_price, dci, therapeutic_action, pharmaceutical_kind, icbper, barcode) VALUES ('${T}', 'KEEP', 'Conservado', 3, 'Amoxicilina', 'Antibiótico', 'GENERIC', true, '99990001')`);
    const r = await importProducts(ctx, [row("KEEP", { category: "Antibióticos" })], farmacia, { apply: true });
    expect(r.updates).toBe(1);
    expect(await product("KEEP")).toMatchObject({ dci: "Amoxicilina", therapeutic_action: "Antibiótico", pharmaceutical_kind: "GENERIC", icbper: true, barcode: "99990001", name: "Conservado" });
    const off = await importProducts(ctx, [row("KEEP", { icbper: false })], farmacia, { apply: true });
    expect(off.updates).toBe(1);
    expect((await product("KEEP")).icbper).toBe(false);
  });

  it("todo o nada: una fila con error impide aplicar cualquiera, y no deja categorías sueltas", async () => {
    const before = await db.product.count({ where: { tenant_id: T } });
    const r = await importProducts(ctx, [
      row("OKFILA", { name: "Bien", salePrice: "1", category: "Categoría que no debe crearse" }),
      row("NOEXISTE", { category: "Otra" }), // nuevo sin nombre ni precio
    ], farmacia, { apply: true });
    expect(r.applied).toBe(false);
    expect(r.errors).toEqual([{ line: expect.any(Number), message: expect.stringContaining("Nombre y Precio de venta") }]);
    expect(await db.product.count({ where: { tenant_id: T } })).toBe(before);
    expect((await categories()).map((c) => c.name)).not.toContain("Categoría que no debe crearse");
  });

  it("no deja robar el código de barras de otro producto, pero sí conservar el propio", async () => {
    await db.$executeRawUnsafe(`INSERT INTO products (tenant_id, sku, name, sale_price, barcode) VALUES ('${T}', 'DUENO', 'Dueño', 1, '77770001')`);
    const bad = await importProducts(ctx, [row("OTRO", { name: "Otro", salePrice: "1", barcode: "77770001" })], farmacia, { apply: true });
    expect(bad.applied).toBe(false);
    expect(bad.errors[0]!.message).toMatch(/ya pertenece al producto DUENO/);
    const own = await importProducts(ctx, [row("DUENO", { barcode: "77770001", category: "Varios" })], farmacia, { apply: true });
    expect(own).toMatchObject({ applied: true, updates: 1 });
  });

  it("sin módulo Farmacia ignora principio activo y tipo, pero carga categoría e ICBPER", async () => {
    const r = await importProducts(ctx, [row("RET1", { name: "Bolsa", salePrice: "0.2", category: "Bolsas", dci: "Paracetamol", kind: "BRAND", therapeuticAction: "X", icbper: true })], retail, { apply: true });
    expect(r.applied).toBe(true);
    expect(r.notes[0]).toMatch(/módulo Farmacia no está activo/);
    expect(await product("RET1")).toMatchObject({ dci: null, pharmaceutical_kind: null, therapeutic_action: null, icbper: true, sale_condition: null });
    expect((await product("RET1")).category_id).not.toBeNull();
  });

  it("un servicio no puede ser una bolsa con ICBPER", async () => {
    await db.$executeRawUnsafe(`INSERT INTO products (tenant_id, sku, name, sale_price, is_service, tracks_batches) VALUES ('${T}', 'SERV', 'Consulta', 30, true, false)`);
    const r = await importProducts(ctx, [row("SERV", { icbper: true })], farmacia, { apply: true });
    expect(r.applied).toBe(false);
    expect(r.errors[0]!.message).toMatch(/servicio/);
  });

  it("deja auditoría solo al aplicar, y cada negocio ve únicamente sus productos", async () => {
    const audits = async () => (await db.$queryRawUnsafe<{ c: number }[]>(`SELECT count(*)::int AS c FROM audit_logs WHERE tenant_id = '${T2}' AND action = 'product.import'`))[0]!.c;
    const other = { tenantId: T2, userId: U };
    const rows = [row("EXIST", { name: "Existente en otro negocio", salePrice: "5", category: "Analgésicos" })];
    const preview = await importProducts(other, rows, farmacia, { apply: false });
    expect(preview).toMatchObject({ creates: 1, updates: 0 }); // EXIST del otro negocio no es visible: aquí se crea
    expect(await audits()).toBe(0);
    await importProducts(other, rows, farmacia, { apply: true });
    expect(await audits()).toBe(1);
    expect(await db.productCategory.count({ where: { tenant_id: T2, name: "Analgésicos" } })).toBe(1);
    expect((await product("EXIST", T)).name).toBe("Existente"); // el negocio T no se tocó
    expect((await categories(T)).filter((c) => c.name === "Analgésicos")).toHaveLength(1);
  });

  it("agrupa los cambios iguales y aplica cientos de filas dentro del tiempo", async () => {
    const skus = Array.from({ length: 400 }, (_, i) => `MASA${String(i).padStart(3, "0")}`);
    await importProducts(ctx, skus.map((s) => row(s, { name: s, salePrice: "1" })), farmacia, { apply: true });
    const t0 = Date.now();
    const r = await importProducts(ctx, skus.map((s) => row(s, { category: "Masivo", kind: "GENERIC" })), farmacia, { apply: true });
    expect(r).toMatchObject({ updates: 400, applied: true, newCategories: ["Masivo"] });
    expect(Date.now() - t0).toBeLessThan(15_000);
    const masivo = (await categories()).find((c) => c.name === "Masivo")!;
    expect(await db.product.count({ where: { tenant_id: T, sku: { startsWith: "MASA" }, category_id: masivo.id, pharmaceutical_kind: "GENERIC" } })).toBe(400);
  });

  it("el catálogo de la caja trae la categoría del producto, y nada si la categoría fue eliminada", async () => {
    const pos = await loadPosContext({ ...ctx, branchIds: [] });
    const by = (sku: string) => pos!.products.find((p) => p.sku === sku)!;
    expect(by("NUEVO")).toMatchObject({ categoryName: "Analgésicos" });
    expect(by("NUEVO").categoryId).not.toBeNull();
    await db.$executeRawUnsafe(`UPDATE product_categories SET deleted_at = now() WHERE tenant_id = '${T}' AND name = 'Masivo'`);
    const after = await loadPosContext({ ...ctx, branchIds: [] });
    expect(after!.products.find((p) => p.sku === "MASA000")!.categoryName).toBeNull();
  });

  it("Inventario cuenta los productos sin categoría o sin tipo y filtra solo los incompletos", async () => {
    await db.$executeRawUnsafe(`UPDATE products SET category_id = NULL, pharmaceutical_kind = NULL WHERE tenant_id = '${T}'`);
    await db.$executeRawUnsafe(`INSERT INTO products (tenant_id, sku, name, sale_price) VALUES ('${T}', 'SINDCI', 'Sin principio activo', 1)`);
    await db.$executeRawUnsafe(`UPDATE products SET category_id = (SELECT id FROM product_categories WHERE tenant_id = '${T}' AND name = 'Analgésicos'), pharmaceutical_kind = 'GENERIC' WHERE tenant_id = '${T}' AND sku = 'NUEVO'`);
    await db.$executeRawUnsafe(`UPDATE products SET category_id = (SELECT id FROM product_categories WHERE tenant_id = '${T}' AND name = 'Analgésicos') WHERE tenant_id = '${T}' AND sku = 'EXIST'`);

    const all = await loadInventoryList(ctx, { pharmacy: true, onlyIncomplete: false });
    const total = await db.product.count({ where: { tenant_id: T, deleted_at: null, is_active: true, is_service: false } });
    expect(all.noCategory).toBe(total - 2); // NUEVO y EXIST sí tienen categoría
    const conDci = await db.product.count({ where: { tenant_id: T, deleted_at: null, is_service: false, dci: { not: null }, pharmaceutical_kind: null } });
    expect(all.noKind).toBe(conDci);
    expect(conDci).toBeGreaterThan(0);

    const only = await loadInventoryList(ctx, { pharmacy: true, onlyIncomplete: true });
    const skus = only.rows.map((r) => r.sku);
    expect(skus).toContain("SINDCI"); // sin categoría
    expect(skus).toContain("EXIST"); // tiene categoría pero es medicamento sin tipo
    expect(skus).not.toContain("NUEVO"); // completo
    expect(skus).not.toContain("SERV"); // un servicio no necesita categoría ni tipo

    const retail = await loadInventoryList(ctx, { pharmacy: false, onlyIncomplete: true });
    expect(retail.noKind).toBe(0); // fuera de una botica el tipo no se exige
    expect(retail.rows.map((r) => r.sku)).not.toContain("EXIST");
  });
});
