/**
 * Integración POS contra PostgreSQL real (migraciones aplicadas).
 *   TEST_DATABASE_URL=postgresql://app_runtime:...@host/db \
 *   TEST_PLATFORM_DATABASE_URL=postgresql://postgres:...@host/db pnpm test
 * Requiere TEST_DATABASE_URL y TEST_PLATFORM_DATABASE_URL (se leen de .env.local).
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const RUNTIME_URL = process.env.TEST_DATABASE_URL;
const PLATFORM_URL = process.env.TEST_PLATFORM_DATABASE_URL;

Object.assign(process.env, {
  NEXT_PUBLIC_APP_URL: "http://localhost:3000",
  DATABASE_URL: RUNTIME_URL ?? "postgresql://x@localhost/x",
  PLATFORM_DATABASE_URL: PLATFORM_URL ?? "postgresql://x@localhost/x",
  NEXT_PUBLIC_SUPABASE_URL: "http://localhost:54321",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test",
  SUPABASE_SERVICE_ROLE_KEY: "test",
  SECRETS_KEK_BASE64: Buffer.alloc(32, 1).toString("base64"),
  SUNAT_BETA_URL: "https://e-beta.sunat.gob.pe/ol-ti-itcpfegem-beta/billService",
  SUNAT_PROD_URL: "https://e-factura.sunat.gob.pe/ol-ti-itcpfegem/billService",
  INTERNAL_CRON_SECRET: "x".repeat(40),
});

const T = randomUUID();
const B = randomUUID();
const P = randomUUID();
const P_EXPIRED = randomUUID();
const U = randomUUID();
const ctx = { tenantId: T, userId: U };
const caps = { canOverridePrice: false, canDispenseRx: false, pharmacyEnabled: false };

describe("POS atómico (PostgreSQL)", async () => {
  const { platformDb, runtimeDb } = await import("@/lib/db");
  const { createSale } = await import("@/lib/inventory/pos");
  const db = platformDb();

  const sale = (key = randomUUID(), qty = 1, productId = P, total = "10.00", customer?: { docType: "DNI" | "NO_DOC"; docNumber: string; name: string }) =>
    createSale(ctx, {
      idempotencyKey: key, branchId: B, docType: "BOLETA", series: "B001",
      customer: customer ?? { docType: "NO_DOC", docNumber: "-", name: "CLIENTES VARIOS" },
      items: [{ productId, quantity: qty }],
      payments: [{ method: "EFECTIVO", amount: total }],
    }, caps);

  beforeAll(async () => {
    const ruc = `20${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`;
    await db.$executeRawUnsafe(`
      INSERT INTO tenants (id, slug, ruc, legal_name, business_lines, fiscal_address, ubigeo, department, province, district, contact_email, status)
      VALUES ('${T}', 'pos-${T.slice(0, 8)}', '${ruc}', 'POS TEST SAC', '{RETAIL}', 'Av 1', '150101', 'LIMA', 'LIMA', 'LIMA', 't@t.pe', 'ACTIVE')`);
    await db.$executeRawUnsafe(`INSERT INTO branches (id, tenant_id, sunat_code, name, address, ubigeo) VALUES ('${B}', '${T}', '0000', 'P', 'Av 1', '150101')`);
    await db.$executeRawUnsafe(`INSERT INTO products (id, tenant_id, sku, name, sale_price) VALUES ('${P}', '${T}', 'SKU1', 'Vacuna X', 10), ('${P_EXPIRED}', '${T}', 'SKU2', 'Producto vencido', 5)`);
    await db.$executeRawUnsafe(`INSERT INTO document_series (tenant_id, branch_id, doc_type, series) VALUES ('${T}', '${B}', 'BOLETA', 'B001')`);
    await db.$executeRawUnsafe(`SELECT app.receive_batch('${T}', '${B}', '${P}', 'L1', app.lima_today() + 30, 4, 5, NULL, NULL)`);
    await db.$executeRawUnsafe(`SELECT app.receive_batch('${T}', '${B}', '${P}', 'L2', app.lima_today() + 300, 6, 5, NULL, NULL)`);
    await db.$executeRawUnsafe(`SELECT app.receive_batch('${T}', '${B}', '${P_EXPIRED}', 'LX', app.lima_today() - 1, 50, 2, NULL, NULL)`);
  });

  afterAll(async () => {
    await runtimeDb().$disconnect();
    await db.$disconnect();
  });

  it("15 ventas concurrentes con stock 10: sin sobreventa, correlativo sin huecos, FEFO", async () => {
    const results = await Promise.allSettled(Array.from({ length: 15 }, () => sale()));
    const okSales = results.filter((r) => r.status === "fulfilled");
    const failures = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(okSales).toHaveLength(10);
    for (const f of failures) expect((f.reason as { code?: string }).code).toBe("INSUFFICIENT_STOCK");

    const numbers = okSales.map((r) => (r as PromiseFulfilledResult<{ number: number }>).value.number).sort((a, b) => a - b);
    expect(numbers).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

    const batches = await db.productBatch.findMany({ where: { product_id: P }, orderBy: { lot_code: "asc" } });
    expect(batches.map((b) => b.stock.toString())).toEqual(["0", "0"]);
    expect(await db.stockMovement.count({ where: { product_id: P, type: "SALE" } })).toBe(10);
    expect(await db.outboxEvent.count({ where: { tenant_id: T, event_type: "document.issued" } })).toBe(10);
    // FEFO: los 4 primeros descuentos salen del lote L1 (vence antes)
    const lots = await db.documentItemLot.groupBy({ by: ["batch_id"], where: { tenant_id: T }, _sum: { quantity: true } });
    expect(lots.map((l) => l._sum.quantity?.toString()).sort()).toEqual(["4", "6"]);
  });

  it("idempotencia: la misma clave en paralelo produce una sola venta", async () => {
    await db.$executeRawUnsafe(`SELECT app.receive_batch('${T}', '${B}', '${P}', 'L3', app.lima_today() + 400, 5, 5, NULL, NULL)`);
    const key = randomUUID();
    const [a, b] = await Promise.all([sale(key), sale(key)]);
    expect(a.documentId).toBe(b.documentId);
    expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
    expect(await db.document.count({ where: { idempotency_key: key } })).toBe(1);
    const l3 = await db.productBatch.findFirstOrThrow({ where: { product_id: P, lot_code: "L3" } });
    expect(l3.stock.toString()).toBe("4");
  });

  it("no vende lotes vencidos", async () => {
    await expect(sale(randomUUID(), 1, P_EXPIRED, "5.00")).rejects.toMatchObject({ code: "INSUFFICIENT_STOCK" });
  });

  it("boleta > S/ 700 sin DNI se rechaza antes de tocar stock", async () => {
    await expect(sale(randomUUID(), 71, P, "710.00")).rejects.toMatchObject({ code: "BOLETA_OVER_700_REQUIRES_ID" });
  });

  it("pagos que no cuadran se rechazan", async () => {
    await expect(sale(randomUUID(), 1, P, "9.00")).rejects.toMatchObject({ code: "PAYMENT_MISMATCH" });
  });

  it("carritos multi-producto en orden inverso, en paralelo: sin deadlocks", async () => {
    const A = randomUUID();
    const C = randomUUID();
    await db.$executeRawUnsafe(`INSERT INTO products (id, tenant_id, sku, name, sale_price) VALUES ('${A}', '${T}', 'SKU-A', 'A', 1), ('${C}', '${T}', 'SKU-C', 'C', 1)`);
    await db.$executeRawUnsafe(`SELECT app.receive_batch('${T}', '${B}', '${A}', 'LA', NULL, 1000, 1, NULL, NULL)`);
    await db.$executeRawUnsafe(`SELECT app.receive_batch('${T}', '${B}', '${C}', 'LC', NULL, 1000, 1, NULL, NULL)`);
    const cart = (first: string, second: string) =>
      createSale(ctx, {
        idempotencyKey: randomUUID(), branchId: B, docType: "BOLETA", series: "B001",
        customer: { docType: "NO_DOC", docNumber: "-", name: "CLIENTES VARIOS" },
        items: [{ productId: first, quantity: 1 }, { productId: second, quantity: 1 }],
        payments: [{ method: "EFECTIVO", amount: "2.00" }],
      }, caps);
    const results = await Promise.allSettled(Array.from({ length: 30 }, (_, i) => (i % 2 ? cart(A, C) : cart(C, A))));
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(rejected.map((r) => String((r.reason as Error).message))).toEqual([]);
    const stocks = await db.productBatch.findMany({ where: { product_id: { in: [A, C] } } });
    expect(stocks.map((b) => b.stock.toString())).toEqual(["970", "970"]);
  });

  it("RLS: otro tenant no ve las ventas", async () => {
    const { withTenant } = await import("@/lib/db");
    const count = await withTenant({ tenantId: randomUUID(), userId: U }, (tx) => tx.document.count());
    expect(count).toBe(0);
  });
});
