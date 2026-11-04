/** Arqueo con notas de crédito: lo devuelto a clientes se descuenta del esperado del turno. */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

Object.assign(process.env, {
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgresql://x@localhost/x",
  PLATFORM_DATABASE_URL: process.env.TEST_PLATFORM_DATABASE_URL ?? "postgresql://x@localhost/x",
});

const T = randomUUID(), B = randomUUID(), P = randomUUID(), U = randomUUID(), OTHER = randomUUID();
const ctx = { tenantId: T, userId: U };
const caps = { canOverridePrice: false, canDispenseRx: false, pharmacyEnabled: false };

describe("Cierre de caja con devoluciones (PostgreSQL)", async () => {
  const { platformDb, runtimeDb } = await import("@/lib/db");
  const { createSale } = await import("@/lib/inventory/pos");
  const { issueCreditNote } = await import("@/lib/sunat/credit-note");
  const cash = await import("@/lib/pos/cash-closure");
  const db = platformDb();

  const sale = async (qty: number, method = "EFECTIVO", c = ctx) => {
    const r = await createSale(c, {
      idempotencyKey: randomUUID(), branchId: B, docType: "BOLETA", series: "B001", customer: { docType: "NO_DOC", docNumber: "-", name: "CLIENTES VARIOS" },
      items: [{ productId: P, saleUnit: "UNIT", quantity: qty }], payments: [{ method: method as "EFECTIVO", amount: (qty * 10).toFixed(2) }], paymentTerms: "Contado",
    }, caps);
    await db.document.update({ where: { id: r.documentId }, data: { status: "ACEPTADO" } });
    return r.documentId;
  };
  const note = (documentId: string, refundMethod?: "EFECTIVO" | "YAPE", c = ctx, key = randomUUID()) => issueCreditNote(c, {
    idempotencyKey: key, documentId, series: "BC01", reasonCode: "07", reasonText: "Devolución del cliente", refundMethod,
  });

  beforeAll(async () => {
    const ruc = `20${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`;
    await db.$executeRawUnsafe(`INSERT INTO tenants (id, slug, ruc, legal_name, business_lines, fiscal_address, ubigeo, department, province, district, contact_email, status)
      VALUES ('${T}', 'cr-${T.slice(0, 8)}', '${ruc}', 'CAJA TEST', '{RETAIL}', 'Av 1', '150101', 'LIMA', 'LIMA', 'LIMA', 'c@t.pe', 'ACTIVE')`);
    await db.$executeRawUnsafe(`INSERT INTO branches (id, tenant_id, sunat_code, name, address, ubigeo) VALUES ('${B}', '${T}', '0000', 'Principal', 'Av 1', '150101')`);
    await db.$executeRawUnsafe(`INSERT INTO document_series (tenant_id, branch_id, doc_type, series) VALUES ('${T}', '${B}', 'BOLETA', 'B001'), ('${T}', '${B}', 'NOTA_CREDITO', 'BC01')`);
    await db.$executeRawUnsafe(`INSERT INTO products (id, tenant_id, sku, name, sale_price) VALUES ('${P}', '${T}', 'P1', 'Producto', 10)`);
    await db.$executeRawUnsafe(`INSERT INTO product_batches (tenant_id, branch_id, product_id, lot_code, expiry_date, stock, unit_cost) VALUES ('${T}', '${B}', '${P}', 'L1', '2099-01-01', 1000, 1)`);
  });
  afterAll(async () => { await runtimeDb().$disconnect(); await db.$disconnect(); });

  it("la devolución en efectivo baja el esperado y permite cuadrar el turno", async () => {
    await sale(10);
    const devuelta = await sale(3);
    await note(devuelta, "EFECTIVO");
    const s = await cash.getCashSummary(ctx, B);
    expect(Number(s.sales.EFECTIVO)).toBe(130);
    expect(Number(s.refunds.EFECTIVO)).toBe(30);
    const r = await cash.closeCash(ctx, { idempotencyKey: randomUUID(), branchId: B, opening: "20", counted: { EFECTIVO: "120", YAPE: "0", PLIN: "0", TARJETA: "0" } });
    expect(r.lines[0]).toMatchObject({ expected: "120.00", refunds: "30.00", difference: "0.00" });
    expect(r.difference).toBe("0.00");
    const stored = await db.cashClosure.findUniqueOrThrow({ where: { id: r.closureId } });
    expect((stored.breakdown as { refunds: string }[])[0]!.refunds).toBe("30.00");
  });

  it("la devolución del turno cerrado no se vuelve a descontar", async () => {
    expect(Number((await cash.getCashSummary(ctx, B)).refunds.EFECTIVO)).toBe(0);
  });

  it("sin medio de devolución, o por otro medio, el efectivo no cambia", async () => {
    await note(await sale(2));
    await note(await sale(1, "YAPE"), "YAPE");
    const s = await cash.getCashSummary(ctx, B);
    expect(Number(s.refunds.EFECTIVO)).toBe(0);
    expect(Number(s.refunds.YAPE)).toBe(10);
    expect(Number(s.sales.EFECTIVO)).toBe(20);
    expect(Number(s.sales.YAPE)).toBe(10);
  });

  it("afecta al cajero que devolvió, no a los demás", async () => {
    const other = { tenantId: T, userId: OTHER };
    const before = await cash.getCashSummary(other, B);
    expect(Number(before.refunds.EFECTIVO)).toBe(0);
    await note(await sale(1), "EFECTIVO");
    expect(Number((await cash.getCashSummary(other, B)).refunds.EFECTIVO)).toBe(0);
    expect(Number((await cash.getCashSummary(ctx, B)).refunds.EFECTIVO)).toBe(10);
  });

  it("repetir la misma nota no descuenta dos veces", async () => {
    const id = await sale(1);
    const key = randomUUID();
    const before = Number((await cash.getCashSummary(ctx, B)).refunds.EFECTIVO);
    await note(id, "EFECTIVO", ctx, key);
    await note(id, "EFECTIVO", ctx, key);
    expect(Number((await cash.getCashSummary(ctx, B)).refunds.EFECTIVO)).toBe(before + 10);
  });
});
