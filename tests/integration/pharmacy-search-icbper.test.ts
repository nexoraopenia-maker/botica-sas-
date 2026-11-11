/** Catálogo farmacológico de la caja, bolsas con ICBPER y reporte de precios y stock contra PostgreSQL real con RLS. */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

Object.assign(process.env, {
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgresql://x@localhost/x",
  PLATFORM_DATABASE_URL: process.env.TEST_PLATFORM_DATABASE_URL ?? "postgresql://x@localhost/x",
});

const T = randomUUID(), T2 = randomUUID(), B = randomUUID(), U = randomUUID();
const MARCA = randomUUID(), GENERICO = randomUUID(), BOLSA = randomUUID(), VENCIDO = randomUUID(), CUARENTENA = randomUUID();
const ctx = { tenantId: T, userId: U };
const caps = { canOverridePrice: false, canDispenseRx: false, pharmacyEnabled: false };

describe("Búsqueda farmacológica, ICBPER y precios con stock (PostgreSQL)", async () => {
  const { platformDb, runtimeDb } = await import("@/lib/db");
  const { createSale } = await import("@/lib/inventory/pos");
  const { loadPosContext } = await import("@/lib/inventory/pos-catalog");
  const { createProduct } = await import("@/lib/inventory/products");
  const dig = await import("@/lib/reports/digemid");
  const db = platformDb();
  const ruc = () => `20${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`;
  const sale = (items: unknown[], amount: string, key = randomUUID()) =>
    createSale(ctx, {
      idempotencyKey: key, branchId: B, docType: "BOLETA", series: "B001", customer: { docType: "NO_DOC", docNumber: "-", name: "CLIENTES VARIOS" },
      items, payments: [{ method: "EFECTIVO", amount }], paymentTerms: "Contado",
    } as never, caps);

  beforeAll(async () => {
    for (const id of [T, T2]) {
      await db.$executeRawUnsafe(`INSERT INTO tenants (id, slug, ruc, legal_name, business_lines, fiscal_address, ubigeo, department, province, district, contact_email, status)
        VALUES ('${id}', 'ib-${id.slice(0, 8)}', '${ruc()}', 'BOTICA TEST', '{PHARMACY}', 'Av 1', '150101', 'LIMA', 'LIMA', 'LIMA', 'b@t.pe', 'ACTIVE')`);
    }
    await db.$executeRawUnsafe(`INSERT INTO branches (id, tenant_id, sunat_code, name, address, ubigeo) VALUES ('${B}', '${T}', '0000', 'Principal', 'Av 1', '150101')`);
    await db.$executeRawUnsafe(`INSERT INTO document_series (tenant_id, branch_id, doc_type, series) VALUES ('${T}', '${B}', 'BOLETA', 'B001')`);
    const role = randomUUID();
    await db.$executeRawUnsafe(`INSERT INTO roles (id, tenant_id, key, name, permissions) VALUES ('${role}', '${T}', 'admin', 'Admin', '{*}')`);
    await db.$executeRawUnsafe(`INSERT INTO users (id, email, full_name) VALUES ('${U}', '${U}@t.pe', 'Vendedor')`);
    await db.$executeRawUnsafe(`INSERT INTO tenant_users (tenant_id, user_id, role_id, status) VALUES ('${T}', '${U}', '${role}', 'ACTIVE')`);
    await db.$executeRawUnsafe(`INSERT INTO products (id, tenant_id, sku, name, sale_price, dci, concentration, pharmaceutical_form, therapeutic_action, pharmaceutical_kind, digemid_product_code)
      VALUES ('${MARCA}', '${T}', 'PANA', 'Panadol 500 mg', 1.5, 'Paracetamol', '500 mg', 'Tableta', 'Analgésico', 'BRAND', '555'),
             ('${GENERICO}', '${T}', 'PMK', 'Paracetamol MK 500 mg', 0.3, 'Paracetamol', '500 mg', 'Tableta', 'Analgésico', 'GENERIC', NULL)`);
    await db.$executeRawUnsafe(`INSERT INTO products (id, tenant_id, sku, name, sale_price, icbper, units_per_package, package_price) VALUES ('${BOLSA}', '${T}', 'BOLSA', 'Bolsa plástica', 0.2, true, 10, 2)`);
    await db.$executeRawUnsafe(`INSERT INTO products (id, tenant_id, sku, name, sale_price, dci) VALUES ('${VENCIDO}', '${T}', 'VENC', 'Vencido', 1, 'Zinc'), ('${CUARENTENA}', '${T}', 'CUAR', 'Cuarentena', 1, 'Hierro')`);
    const batch = (product: string, lot: string, days: number, stock: number, quarantined = false) =>
      db.$executeRawUnsafe(`INSERT INTO product_batches (tenant_id, branch_id, product_id, lot_code, expiry_date, stock, unit_cost, is_quarantined)
        VALUES ('${T}', '${B}', '${product}', '${lot}', (now() AT TIME ZONE 'America/Lima')::date + ${days}, ${stock}, 0.1, ${quarantined})`);
    await batch(MARCA, "M1", 300, 40);
    await batch(GENERICO, "G1", 300, 100);
    await batch(BOLSA, "B1", 300, 500);
    await batch(VENCIDO, "V1", -1, 7);
    await batch(CUARENTENA, "Q1", 300, 9, true);
  });
  afterAll(async () => { await runtimeDb().$disconnect(); await db.$disconnect(); });

  it("el catálogo de la caja trae principio activo, concentración, acción terapéutica y si es bolsa", async () => {
    const pos = await loadPosContext({ ...ctx, branchIds: [] });
    const marca = pos!.products.find((p) => p.id === MARCA)!;
    expect(marca).toMatchObject({ dci: "Paracetamol", concentration: "500 mg", pharmaceuticalForm: "Tableta", therapeuticAction: "Analgésico", pharmaceuticalKind: "BRAND", icbper: false });
    expect(pos!.products.find((p) => p.id === BOLSA)!.icbper).toBe(true);
  });

  it("una bolsa suma ICBPER al total, lo muestra aparte del IGV y lo guarda por línea", async () => {
    const r = await sale([{ productId: BOLSA, saleUnit: "UNIT", quantity: 2 }], "1.40");
    expect(r.total).toBe("1.40");
    expect(r.icbper).toBe("1.00");
    expect(r.igv).toBe("0.06");
    const doc = await db.document.findUniqueOrThrow({ where: { id: r.documentId } });
    expect([doc.op_gravadas.toFixed(2), doc.igv.toFixed(2), doc.icbper.toFixed(2), doc.total.toFixed(2)]).toEqual(["0.34", "0.06", "1.00", "1.40"]);
    const item = await db.documentItem.findFirstOrThrow({ where: { document_id: r.documentId } });
    expect(item.icbper_units).toBe(2);
    expect(item.icbper_amount.toFixed(2)).toBe("1.00");
  });

  it("un paquete de bolsas paga ICBPER por cada bolsa, no por paquete", async () => {
    const r = await sale([{ productId: BOLSA, saleUnit: "PACKAGE", quantity: 1 }], "7.00");
    expect(r.icbper).toBe("5.00");
    const item = await db.documentItem.findFirstOrThrow({ where: { document_id: r.documentId } });
    expect(item.icbper_units).toBe(10);
    await expect(sale([{ productId: BOLSA, saleUnit: "PACKAGE", quantity: 1 }], "2.00")).rejects.toMatchObject({ code: "PAYMENT_MISMATCH" });
  });

  it("un producto sin marca de bolsa no paga ICBPER", async () => {
    const r = await sale([{ productId: GENERICO, saleUnit: "UNIT", quantity: 1 }], "0.30");
    expect(r.icbper).toBe("0.00");
  });

  it("repetir la venta con la misma clave devuelve el mismo ICBPER", async () => {
    const key = randomUUID();
    const a = await sale([{ productId: BOLSA, saleUnit: "UNIT", quantity: 1 }], "0.70", key);
    const b = await sale([{ productId: BOLSA, saleUnit: "UNIT", quantity: 1 }], "0.70", key);
    expect(b.replayed).toBe(true);
    expect([b.documentId, b.icbper]).toEqual([a.documentId, "0.50"]);
  });

  it("crea un producto con acción terapéutica y marca de bolsa, y solo en una botica", async () => {
    const pharmacy = { canAdjustStock: false, modules: new Set(["PHARMACY"]) };
    const base = { name: "Ibuprofeno 400 mg", sku: "IBU400", salePrice: "0.4", dci: "Ibuprofeno", therapeuticAction: "Antiinflamatorio" };
    const r = await createProduct(ctx, base, pharmacy);
    expect(await db.product.findUniqueOrThrow({ where: { id: r.productId } })).toMatchObject({ therapeutic_action: "Antiinflamatorio", dci: "Ibuprofeno", icbper: false });
    const bag = await createProduct(ctx, { name: "Bolsa grande", sku: "BOLSAG", salePrice: "0.3", icbper: true }, pharmacy);
    expect((await db.product.findUniqueOrThrow({ where: { id: bag.productId } })).icbper).toBe(true);
    const vet = await createProduct(ctx, { ...base, sku: "IBU401" }, { canAdjustStock: false, modules: new Set(["VETERINARY"]) });
    expect((await db.product.findUniqueOrThrow({ where: { id: vet.productId } })).therapeutic_action).toBeNull();
    await expect(createProduct(ctx, { name: "Servicio bolsa", sku: "SRVB", salePrice: "1", isService: true, icbper: true }, pharmacy)).rejects.toThrow();
  });

  it("el reporte de precios y stock excluye lotes vencidos y en cuarentena, y exige sucursal propia", async () => {
    const rows = await dig.loadPriceStockRows(ctx, B);
    const by = (sku: string) => rows.find((r) => r.sku === sku)!;
    expect(by("PANA")).toMatchObject({ productCode: "555", unitPrice: "1.50", packagePrice: "1.50", stock: "40" });
    expect(by("PMK")).toMatchObject({ productCode: null, stock: "99" }); // 100 menos la unidad vendida arriba
    expect(by("VENC").stock).toBe("0");
    expect(by("CUAR").stock).toBe("0");
    expect(rows.find((r) => r.sku === "BOLSA")).toBeUndefined();
    const audit = await db.$queryRawUnsafe<{ c: number }[]>(`SELECT count(*)::int AS c FROM audit_logs WHERE tenant_id = '${T}' AND action = 'digemid.price_stock_export'`);
    expect(audit[0]!.c).toBe(1);
    await expect(dig.loadPriceStockRows({ tenantId: T2, userId: U }, B)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
