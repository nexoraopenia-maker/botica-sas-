/** Alta de productos contra PostgreSQL real con RLS. */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

Object.assign(process.env, {
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgresql://x@localhost/x",
  PLATFORM_DATABASE_URL: process.env.TEST_PLATFORM_DATABASE_URL ?? "postgresql://x@localhost/x",
});

const T = randomUUID();
const B = randomUUID();
const ctx = { tenantId: T, userId: randomUUID() };
const caps = { canAdjustStock: true, modules: new Set(["CORE", "PHARMACY"]) };

describe("Alta de productos (PostgreSQL)", async () => {
  const { platformDb, runtimeDb } = await import("@/lib/db");
  const { createProduct } = await import("@/lib/inventory/products");
  const db = platformDb();

  beforeAll(async () => {
    const ruc = `20${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`;
    await db.$executeRawUnsafe(`INSERT INTO tenants (id, slug, ruc, legal_name, business_lines, fiscal_address, ubigeo, department, province, district, contact_email, status)
      VALUES ('${T}', 'prd-${T.slice(0, 8)}', '${ruc}', 'PRD TEST', '{PHARMACY}', 'Av 1', '150101', 'LIMA', 'LIMA', 'LIMA', 'p@t.pe', 'ACTIVE')`);
    await db.$executeRawUnsafe(`INSERT INTO branches (id, tenant_id, sunat_code, name, address, ubigeo) VALUES ('${B}', '${T}', '0000', 'Principal', 'Av 1', '150101')`);
  });
  afterAll(async () => { await runtimeDb().$disconnect(); await db.$disconnect(); });

  it("crea producto con categoría nueva, código de barras y stock inicial (kardex de ajuste)", async () => {
    const r = await createProduct(ctx, {
      name: "Paracetamol 500 mg", sku: "para-500", barcode: " 2000000000015 ", newCategory: "Analgésicos", salePrice: "0.50",
      dci: "Paracetamol", saleCondition: "FREE", unitsPerPackage: 100, packagePrice: "40",
      initialStock: { branchId: B, quantity: "250", unitCost: "0.12", lotCode: "L1", expiryDate: "2028-01-31" },
    }, caps);
    expect(r.warnings).toEqual([]);
    const p = await db.product.findUniqueOrThrow({ where: { id: r.productId }, include: { category: true } });
    expect([p.sku, p.barcode, p.category?.name, p.units_per_package]).toEqual(["PARA-500", "2000000000015", "Analgésicos", 100]);
    const batch = await db.productBatch.findFirstOrThrow({ where: { product_id: p.id } });
    expect(batch.stock.toString()).toBe("250");
    const mov = await db.stockMovement.findFirstOrThrow({ where: { product_id: p.id } });
    expect(mov.type).toBe("ADJUSTMENT_IN");
  });

  it("rechaza código de barras o SKU duplicados", async () => {
    await expect(createProduct(ctx, { name: "Otro", sku: "OTRO-1", barcode: "2000000000015", salePrice: 1 }, caps)).rejects.toMatchObject({ code: "DUPLICATE" });
    await expect(createProduct(ctx, { name: "Otro", sku: "PARA-500", salePrice: 1 }, caps)).rejects.toMatchObject({ code: "DUPLICATE" });
  });

  it("advierte EAN con dígito verificador inválido y exige permisos para stock inicial", async () => {
    const r = await createProduct(ctx, { name: "Jeringa 5 ml", sku: "JER-5", barcode: "2000000000016", salePrice: "0.5" }, caps);
    expect(r.warnings.length).toBe(1);
    await expect(createProduct(ctx, { name: "Gasa", sku: "GASA", salePrice: 1, initialStock: { branchId: B, quantity: 1, unitCost: 0 } },
      { ...caps, canAdjustStock: false })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("controlado exige receta retenida; otro tenant no ve la categoría", async () => {
    await expect(createProduct(ctx, { name: "Clonazepam", sku: "CLON", salePrice: 1, isControlled: true, saleCondition: "FREE" }, caps)).rejects.toThrow();
    const cat = await db.productCategory.findFirstOrThrow({ where: { tenant_id: T } });
    await expect(createProduct({ tenantId: randomUUID(), userId: ctx.userId }, { name: "X producto", sku: "XP", salePrice: 1, categoryId: cat.id }, caps))
      .rejects.toMatchObject({ code: "VALIDATION" });
  });
});
