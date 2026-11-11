/** Arqueo con notas de crédito: lo devuelto a clientes se descuenta del esperado del turno. */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SYSTEM_ROLES } from "@/lib/auth/permissions";

Object.assign(process.env, {
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgresql://x@localhost/x",
  PLATFORM_DATABASE_URL: process.env.TEST_PLATFORM_DATABASE_URL ?? "postgresql://x@localhost/x",
});

const T = randomUUID(), B = randomUUID(), P = randomUUID(), U = randomUUID(), OTHER = randomUUID();
const ctx = { tenantId: T, userId: U };
const caps = { canOverridePrice: false, canDispenseRx: false, pharmacyEnabled: false };
// Permisos reales de los roles del sistema: la regla de controlados se decide con ellos
const CASHIER = { ...ctx, permissions: SYSTEM_ROLES.cashier!.permissions as readonly string[] };
const PHARMACIST = { ...ctx, permissions: SYSTEM_ROLES.pharmacist!.permissions as readonly string[] };
const ADMIN = { ...ctx, permissions: ["*"] as readonly string[] };

describe("Cierre de caja con devoluciones (PostgreSQL)", async () => {
  const { platformDb, runtimeDb } = await import("@/lib/db");
  const { createSale } = await import("@/lib/inventory/pos");
  const { issueCreditNote, loadCreditNoteContext } = await import("@/lib/sunat/credit-note");
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
    idempotencyKey: key, documentId, series: "BC01", reasonCode: "06", reasonText: "Devolución del cliente", refundMethod,
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

  it("solo admite los motivos implementados, y los totales no aceptan una nota previa", async () => {
    const id = await sale(2);
    await expect(issueCreditNote(ctx, { idempotencyKey: randomUUID(), documentId: id, series: "BC01", reasonCode: "04" as never, reasonText: "Descuento global" })).rejects.toThrow();
    await expect(issueCreditNote(ctx, { idempotencyKey: randomUUID(), documentId: id, series: "BC01", reasonCode: "02", reasonText: "Error de RUC" })).rejects.toMatchObject({ code: "INVALID_REASON" });
    await expect(issueCreditNote(ctx, { idempotencyKey: randomUUID(), documentId: id, series: "BC01", reasonCode: "07", reasonText: "Sin líneas" })).rejects.toMatchObject({ code: "LINES_REQUIRED" });
    const item = await db.documentItem.findFirstOrThrow({ where: { document_id: id } });
    await issueCreditNote(ctx, { idempotencyKey: randomUUID(), documentId: id, series: "BC01", reasonCode: "07", reasonText: "Devuelve una unidad", lines: [{ itemId: item.id, quantity: 1 }] });
    await expect(note(id)).rejects.toMatchObject({ code: "ALREADY_CREDITED" });
    await expect(issueCreditNote(ctx, { idempotencyKey: randomUUID(), documentId: id, series: "BC01", reasonCode: "07", reasonText: "Fracción", lines: [{ itemId: item.id, quantity: 0.5 }] })).rejects.toMatchObject({ code: "INVALID_QTY" });
    await expect(issueCreditNote(ctx, { idempotencyKey: randomUUID(), documentId: id, series: "BC01", reasonCode: "07", reasonText: "De más", lines: [{ itemId: item.id, quantity: 2 }] })).rejects.toMatchObject({ code: "OVER_CREDIT" });
    const ok = await issueCreditNote(ctx, { idempotencyKey: randomUUID(), documentId: id, series: "BC01", reasonCode: "07", reasonText: "Devuelve la otra", lines: [{ itemId: item.id, quantity: 1 }] });
    expect(ok.number).toBeGreaterThan(0);
  });

  it("una nota rechazada sigue contando: no se puede reponer dos veces", async () => {
    const id = await sale(1);
    const before = (await db.productBatch.aggregate({ where: { product_id: P }, _sum: { stock: true } }))._sum.stock!.toNumber();
    const n = await note(id);
    await db.document.update({ where: { id: n.documentId }, data: { status: "RECHAZADO" } });
    const item = await db.documentItem.findFirstOrThrow({ where: { document_id: id } });
    await expect(issueCreditNote(ctx, { idempotencyKey: randomUUID(), documentId: id, series: "BC01", reasonCode: "07", reasonText: "Otra vez", lines: [{ itemId: item.id, quantity: 1 }] })).rejects.toMatchObject({ code: "OVER_CREDIT" });
    expect((await db.productBatch.aggregate({ where: { product_id: P }, _sum: { stock: true } }))._sum.stock!.toNumber()).toBe(before + 1);
    const ctxData = await loadCreditNoteContext(ctx, id);
    expect(ctxData).toMatchObject({ hasRejectedNote: true, fullyCredited: true });
    expect(ctxData!.blocker).toMatch(/por completo/);
  });

  it("no devuelve dinero de una venta a crédito ni emite sobre un comprobante no aceptado", async () => {
    const r = await createSale(ctx, {
      idempotencyKey: randomUUID(), branchId: B, docType: "BOLETA", series: "B001", customer: { docType: "NO_DOC", docNumber: "-", name: "CLIENTES VARIOS" },
      items: [{ productId: P, saleUnit: "UNIT", quantity: 1 }], payments: [{ method: "EFECTIVO", amount: "10.00" }], paymentTerms: "Contado",
    }, caps);
    expect((await loadCreditNoteContext(ctx, r.documentId))!.blocker).toMatch(/aceptado/);
    await expect(note(r.documentId)).rejects.toThrow(/aceptados/);
    await db.document.update({ where: { id: r.documentId }, data: { status: "ACEPTADO", payment_terms: "Credito" } });
    await expect(note(r.documentId, "EFECTIVO")).rejects.toMatchObject({ code: "REFUND_ON_CREDIT" });
  });

  it("el mismo producto en dos presentaciones se devuelve completo, y el contexto reparte lo acreditado", async () => {
    await db.product.update({ where: { id: P }, data: { units_per_blister: 10, units_per_package: 100, blister_price: 90, package_price: 800 } });
    const r = await createSale(ctx, {
      idempotencyKey: randomUUID(), branchId: B, docType: "BOLETA", series: "B001", customer: { docType: "NO_DOC", docNumber: "-", name: "CLIENTES VARIOS" },
      items: [{ productId: P, saleUnit: "BLISTER", quantity: 1 }, { productId: P, saleUnit: "UNIT", quantity: 2 }], payments: [{ method: "EFECTIVO", amount: "110.00" }], paymentTerms: "Contado",
    }, caps);
    await db.document.update({ where: { id: r.documentId }, data: { status: "ACEPTADO" } });
    const items = await db.documentItem.findMany({ where: { document_id: r.documentId }, orderBy: { line_no: "asc" } });
    await issueCreditNote(ctx, { idempotencyKey: randomUUID(), documentId: r.documentId, series: "BC01", reasonCode: "07", reasonText: "Devuelve blíster", lines: [{ itemId: items[0]!.id, quantity: 1 }] });
    const c = await loadCreditNoteContext(ctx, r.documentId);
    expect(c!.lines.map((l) => l.remaining)).toEqual(["0", "2"]);
    await issueCreditNote(ctx, { idempotencyKey: randomUUID(), documentId: r.documentId, series: "BC01", reasonCode: "07", reasonText: "Devuelve unidades", lines: [{ itemId: items[1]!.id, quantity: 2 }] });
    expect((await loadCreditNoteContext(ctx, r.documentId))!.fullyCredited).toBe(true);
    await db.product.update({ where: { id: P }, data: { units_per_blister: 1, units_per_package: 1, blister_price: null, package_price: null } });
  });

  /** Venta con un controlado (con receta) y, opcionalmente, un producto libre en la misma boleta. */
  const controlledSale = async (opts: { withFree?: boolean } = {}) => {
    const C = randomUUID();
    await db.$executeRawUnsafe(`INSERT INTO products (id, tenant_id, sku, name, sale_price, is_controlled, sale_condition) VALUES ('${C}', '${T}', 'C${C.slice(0, 8).toUpperCase()}', 'Diazepam', 10, true, 'RETAINED_PRESCRIPTION')`);
    const batch = (await db.$queryRawUnsafe<{ id: string }[]>(`INSERT INTO product_batches (tenant_id, branch_id, product_id, lot_code, expiry_date, stock, unit_cost) VALUES ('${T}', '${B}', '${C}', 'LC', '2099-01-01', 10, 1) RETURNING id`))[0]!.id;
    await db.$executeRawUnsafe(`INSERT INTO controlled_substance_log (tenant_id, branch_id, product_id, batch_id, movement, quantity, balance, recorded_by) VALUES ('${T}', '${B}', '${C}', '${batch}', 'IN', 10, 0, '${U}')`);
    const rx = randomUUID();
    await db.$executeRawUnsafe(`INSERT INTO prescriptions (id, tenant_id, branch_id, kind, patient_name, prescriber_name, prescriber_cmp, issued_at, retained, validated_by) VALUES ('${rx}', '${T}', '${B}', 'SPECIAL', 'Luis', 'Dra', '4567', (now() AT TIME ZONE 'America/Lima')::date, true, '${U}')`);
    const r = await createSale(ctx, {
      idempotencyKey: randomUUID(), branchId: B, docType: "BOLETA", series: "B001", customer: { docType: "NO_DOC", docNumber: "-", name: "CLIENTES VARIOS" },
      items: [{ productId: C, saleUnit: "UNIT" as const, quantity: 3, prescriptionId: rx }, ...(opts.withFree ? [{ productId: P, saleUnit: "UNIT" as const, quantity: 2 }] : [])],
      payments: [{ method: "EFECTIVO", amount: opts.withFree ? "50.00" : "30.00" }], paymentTerms: "Contado",
    }, { ...caps, canDispenseRx: true, pharmacyEnabled: true });
    await db.document.update({ where: { id: r.documentId }, data: { status: "ACEPTADO" } });
    return { C, batch, documentId: r.documentId };
  };
  const notesOf = (documentId: string) => db.document.count({ where: { ref_document_id: documentId, doc_type: "NOTA_CREDITO" } });

  it("el farmacéutico devuelve un controlado: repone el libro con su lote y el saldo sigue al stock", async () => {
    const { batch, documentId } = await controlledSale();
    const n = await note(documentId, "EFECTIVO", PHARMACIST);
    const log = await db.controlledSubstanceLog.findFirstOrThrow({ where: { document_id: n.documentId } });
    expect(log).toMatchObject({ movement: "IN", batch_id: batch, recorded_by: U });
    expect(log.quantity.toNumber()).toBe(3);
    expect(log.balance.toNumber()).toBe(10);
    const stock = await db.productBatch.findUniqueOrThrow({ where: { id: batch } });
    expect(stock.stock.toNumber()).toBe(10);
  });

  it("el administrador también puede devolver un controlado", async () => {
    const { documentId } = await controlledSale();
    const n = await note(documentId, "EFECTIVO", ADMIN);
    expect(await db.controlledSubstanceLog.count({ where: { document_id: n.documentId, movement: "IN" } })).toBe(1);
  });

  it("el cajero no puede devolver un controlado: 403 con el mensaje exacto y sin efectos", async () => {
    const { C, batch, documentId } = await controlledSale();
    const stockBefore = (await db.productBatch.findUniqueOrThrow({ where: { id: batch } })).stock.toNumber();
    const logsBefore = await db.controlledSubstanceLog.count({ where: { product_id: C } });
    const cashBefore = Number((await cash.getCashSummary(CASHIER, B)).refunds.EFECTIVO);
    await expect(note(documentId, "EFECTIVO", CASHIER)).rejects.toMatchObject({
      code: "FORBIDDEN", message: "Solo el Químico Farmacéutico o Administrador puede emitir notas de crédito para medicamentos controlados.",
    });
    expect(await notesOf(documentId)).toBe(0);
    expect((await db.productBatch.findUniqueOrThrow({ where: { id: batch } })).stock.toNumber()).toBe(stockBefore);
    expect(await db.controlledSubstanceLog.count({ where: { product_id: C } })).toBe(logsBefore);
    expect(Number((await cash.getCashSummary(CASHIER, B)).refunds.EFECTIVO)).toBe(cashBefore);
    // Y el farmacéutico sí puede sobre la misma venta, porque nada quedó a medias
    await expect(note(documentId, "EFECTIVO", PHARMACIST)).resolves.toBeTruthy();
  });

  it("sin permisos en la sesión no se emite nota con controlados (niega por defecto)", async () => {
    const { documentId } = await controlledSale();
    await expect(note(documentId, undefined, ctx)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await notesOf(documentId)).toBe(0);
  });

  it("en una venta mixta el cajero devuelve lo libre pero no el controlado", async () => {
    const { documentId } = await controlledSale({ withFree: true });
    const all = await db.documentItem.findMany({ where: { document_id: documentId }, orderBy: { line_no: "asc" } });
    const flags = new Map((await db.product.findMany({ where: { id: { in: all.map((i) => i.product_id!) } }, select: { id: true, is_controlled: true } })).map((p) => [p.id, p.is_controlled]));
    const controlled = all.find((i) => flags.get(i.product_id!))!, free = all.find((i) => !flags.get(i.product_id!))!;
    const partial = (itemId: string, c: typeof CASHIER) => issueCreditNote(c, { idempotencyKey: randomUUID(), documentId, series: "BC01", reasonCode: "07", reasonText: "Devolución parcial", lines: [{ itemId, quantity: 1 }] });
    await expect(partial(controlled.id, CASHIER)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(note(documentId, "EFECTIVO", CASHIER)).rejects.toMatchObject({ code: "FORBIDDEN" }); // devolución total incluye el controlado
    expect(await notesOf(documentId)).toBe(0);
    const n = await partial(free.id, CASHIER);
    expect(await db.controlledSubstanceLog.count({ where: { document_id: n.documentId } })).toBe(0);
    const context = await loadCreditNoteContext(CASHIER, documentId);
    expect(context!.lines.find((l) => l.id === controlled.id)!.controlled).toBe(true);
    expect(context!.lines.find((l) => l.id === free.id)!.controlled).toBe(false);
    await expect(partial(controlled.id, PHARMACIST)).resolves.toBeTruthy();
  });

  it("descuenta la caja de quien emite aunque la venta sea de otra sucursal", async () => {
    const CAJA = randomUUID();
    await db.branch.create({ data: { id: CAJA, tenant_id: T, sunat_code: "0001", name: "Caja del cajero", address: "x", ubigeo: "150101" } });
    const id = await sale(1);
    const ventaAntes = Number((await cash.getCashSummary(ctx, B)).refunds.EFECTIVO);
    const cajaAntes = Number((await cash.getCashSummary(ctx, CAJA)).refunds.EFECTIVO);
    const r = await issueCreditNote({ ...ctx, branchIds: [CAJA] }, { idempotencyKey: randomUUID(), documentId: id, series: "BC01", reasonCode: "06", reasonText: "Devolución del cliente", refundMethod: "EFECTIVO" });
    expect((await db.document.findUniqueOrThrow({ where: { id: r.documentId } })).branch_id).toBe(B);
    expect(Number((await cash.getCashSummary(ctx, CAJA)).refunds.EFECTIVO)).toBe(cajaAntes + 10);
    expect(Number((await cash.getCashSummary(ctx, B)).refunds.EFECTIVO)).toBe(ventaAntes);
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
