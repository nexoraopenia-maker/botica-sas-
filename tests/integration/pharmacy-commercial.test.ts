/** Fraccionamiento, monedero, vendedores, comisiones y lotes contra PostgreSQL real con RLS. */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

Object.assign(process.env, {
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgresql://x@localhost/x",
  PLATFORM_DATABASE_URL: process.env.TEST_PLATFORM_DATABASE_URL ?? "postgresql://x@localhost/x",
});

const T = randomUUID(), T2 = randomUUID(), B = randomUUID(), P = randomUUID(), PX = randomUUID(), U = randomUUID(), S2 = randomUUID(), OUTSIDER = randomUUID();
const ctx = { tenantId: T, userId: U };
const caps = { canOverridePrice: false, canDispenseRx: false, pharmacyEnabled: false };
const DNI = "44556677";

describe("Módulos de botica (PostgreSQL)", async () => {
  const { platformDb, runtimeDb, withTenant } = await import("@/lib/db");
  const { createSale } = await import("@/lib/inventory/pos");
  const { loadPosContext } = await import("@/lib/inventory/pos-catalog");
  const { issueCreditNote } = await import("@/lib/sunat/credit-note");
  const { approveIngestion } = await import("@/lib/ai/ingestion/commit");
  const com = await import("@/lib/reports/commissions");
  const dig = await import("@/lib/reports/digemid");
  const wal = await import("@/lib/loyalty/wallet");
  const db = platformDb();
  const ruc = () => `20${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`;
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Lima" }).format(new Date());

  const sale = (over: Record<string, unknown> = {}, items: unknown[] = [{ productId: P, saleUnit: "UNIT", quantity: 10 }], payments: unknown[] = [{ method: "EFECTIVO", amount: "5.00" }]) =>
    createSale(ctx, {
      idempotencyKey: randomUUID(), branchId: B, docType: "BOLETA", series: "B001", customer: { docType: "DNI", docNumber: DNI, name: "Ana Soto" },
      items, payments, paymentTerms: "Contado", ...over,
    } as never, caps);
  const stock = async (id = P) => (await db.productBatch.aggregate({ where: { product_id: id }, _sum: { stock: true } }))._sum.stock!.toNumber();

  beforeAll(async () => {
    for (const id of [T, T2]) {
      await db.$executeRawUnsafe(`INSERT INTO tenants (id, slug, ruc, legal_name, business_lines, fiscal_address, ubigeo, department, province, district, contact_email, status)
        VALUES ('${id}', 'ph-${id.slice(0, 8)}', '${ruc()}', 'BOTICA TEST', '{PHARMACY}', 'Av 1', '150101', 'LIMA', 'LIMA', 'LIMA', 'b@t.pe', 'ACTIVE')`);
    }
    await db.$executeRawUnsafe(`INSERT INTO branches (id, tenant_id, sunat_code, name, address, ubigeo) VALUES ('${B}', '${T}', '0000', 'Principal', 'Av 1', '150101')`);
    await db.$executeRawUnsafe(`INSERT INTO document_series (tenant_id, branch_id, doc_type, series) VALUES ('${T}', '${B}', 'BOLETA', 'B001'), ('${T}', '${B}', 'NOTA_CREDITO', 'BC01')`);
    const role = randomUUID();
    await db.$executeRawUnsafe(`INSERT INTO roles (id, tenant_id, key, name, permissions) VALUES ('${role}', '${T}', 'admin', 'Admin', '{*}')`);
    for (const u of [U, S2, OUTSIDER]) await db.$executeRawUnsafe(`INSERT INTO users (id, email, full_name) VALUES ('${u}', '${u}@t.pe', 'V ${u.slice(0, 4)}')`);
    for (const u of [U, S2]) await db.$executeRawUnsafe(`INSERT INTO tenant_users (tenant_id, user_id, role_id, status) VALUES ('${T}', '${u}', '${role}', 'ACTIVE')`);
    await db.$executeRawUnsafe(`INSERT INTO products (id, tenant_id, sku, name, sale_price, package_price, units_per_package, units_per_blister, blister_price, digemid_product_code)
      VALUES ('${P}', '${T}', 'PARA', 'Paracetamol', 0.5, 80, 200, 10, 4.5, '01234')`);
    await db.$executeRawUnsafe(`INSERT INTO product_batches (tenant_id, branch_id, product_id, lot_code, expiry_date, stock, unit_cost) VALUES ('${T}', '${B}', '${P}', 'L1', (now() AT TIME ZONE 'America/Lima')::date + 20, 1000, 0.1)`);
    await db.$executeRawUnsafe(`INSERT INTO products (id, tenant_id, sku, name, sale_price) VALUES ('${PX}', '${T}', 'VENC', 'Vencido', 1)`);
    await db.$executeRawUnsafe(`INSERT INTO product_batches (tenant_id, branch_id, product_id, lot_code, expiry_date, stock, unit_cost) VALUES ('${T}', '${B}', '${PX}', 'LX', (now() AT TIME ZONE 'America/Lima')::date - 1, 7, 1)`);
    await wal.saveLoyaltySettings(ctx, { enabled: true, earnPercent: "10" });
  });
  afterAll(async () => { await runtimeDb().$disconnect(); await db.$disconnect(); });

  it("rechaza un blíster que no entra entero en la caja", async () => {
    await expect(db.product.update({ where: { id: P }, data: { units_per_blister: 7 } })).rejects.toThrow();
  });

  it("vender blíster y caja descuenta unidades base en lote y kardex", async () => {
    const before = await stock();
    const r = await sale({}, [{ productId: P, saleUnit: "BLISTER", quantity: 2 }], [{ method: "EFECTIVO", amount: "9.00" }]);
    expect(r.total).toBe("9.00");
    expect(await stock()).toBe(before - 20);
    const item = await db.documentItem.findFirstOrThrow({ where: { document_id: r.documentId } });
    expect(item.sale_unit).toBe("BLISTER");
    expect(item.base_quantity.toNumber()).toBe(20);
    expect(item.description).toContain("blíster x10");
    const mv = await db.stockMovement.findFirstOrThrow({ where: { ref_id: r.documentId } });
    expect(mv.quantity.toNumber()).toBe(-20);
    const c = await sale({}, [{ productId: P, saleUnit: "PACKAGE", quantity: 1 }], [{ method: "EFECTIVO", amount: "80.00" }]);
    expect(c.total).toBe("80.00");
    expect(await stock()).toBe(before - 220);
  });

  it("el catálogo avisa del lote vencido y del próximo a vencer; un vencido no se vende", async () => {
    const pos = await loadPosContext({ ...ctx, branchIds: [] });
    const px = pos!.products.find((p) => p.id === PX)!;
    expect(Number(px.available)).toBe(0);
    expect(Number(px.expiredStock)).toBe(7);
    expect(pos!.products.find((p) => p.id === P)!.nearestExpiry).not.toBeNull();
    expect(pos!.today).toBe(today);
    await expect(sale({}, [{ productId: PX, saleUnit: "UNIT", quantity: 1 }], [{ method: "EFECTIVO", amount: "1.00" }])).rejects.toMatchObject({ code: "INSUFFICIENT_STOCK" });
  });

  it("monedero: acumula, paga, no gasta de más y no se puede alterar", async () => {
    const first = await sale({}, [{ productId: P, saleUnit: "PACKAGE", quantity: 1 }], [{ method: "YAPE", amount: "80.00" }]);
    expect(first.wallet?.earned).toBe("8.00");
    const balance = Number(first.wallet!.balance);

    // Parte con monedero: gana solo sobre lo pagado con dinero
    const mixed = await sale({}, [{ productId: P, saleUnit: "BLISTER", quantity: 2 }], [{ method: "MONEDERO", amount: "4.00" }, { method: "EFECTIVO", amount: "5.00" }]);
    expect(mixed.wallet).toMatchObject({ redeemed: "4.00", earned: "0.50" });
    expect(Number(mixed.wallet!.balance)).toBeCloseTo(balance - 3.5, 2);

    await expect(sale({}, [{ productId: P, saleUnit: "PACKAGE", quantity: 1 }], [{ method: "MONEDERO", amount: "80.00" }])).rejects.toMatchObject({ code: "WALLET_INSUFFICIENT" });
    await expect(sale({ customer: { docType: "NO_DOC", docNumber: "-", name: "CLIENTES VARIOS" } }, [{ productId: P, saleUnit: "UNIT", quantity: 2 }], [{ method: "MONEDERO", amount: "1.00" }])).rejects.toMatchObject({ code: "WALLET_NEEDS_CUSTOMER" });
    await expect(withTenant(ctx, (tx) => tx.walletTransaction.updateMany({ data: { amount: 1 } }))).rejects.toThrow();
    await expect(withTenant(ctx, (tx) => tx.walletTransaction.deleteMany())).rejects.toThrow();
    expect(await wal.walletBalance(ctx, "DNI", DNI)).toBe(mixed.wallet!.balance);
    expect(await wal.walletBalance({ tenantId: T2, userId: U }, "DNI", DNI)).toBeNull();
  });

  it("dos ventas simultáneas no gastan el mismo saldo", async () => {
    const bal = Number(await wal.walletBalance(ctx, "DNI", DNI));
    const amount = bal.toFixed(2);
    const p = Math.ceil(bal / 0.5);
    const go = () => sale({}, [{ productId: P, saleUnit: "UNIT", quantity: p }], [{ method: "MONEDERO", amount: amount }, ...(p * 0.5 - bal > 0 ? [{ method: "EFECTIVO", amount: (p * 0.5 - bal).toFixed(2) }] : [])]);
    const r = await Promise.allSettled([go(), go()]);
    expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect(Number(await wal.walletBalance(ctx, "DNI", DNI))).toBeGreaterThanOrEqual(0);
  });

  it("la venta fallida no toca el monedero", async () => {
    const before = await wal.walletBalance(ctx, "DNI", DNI);
    await expect(sale({}, [{ productId: P, saleUnit: "PACKAGE", quantity: 99 }], [{ method: "EFECTIVO", amount: "7920.00" }])).rejects.toMatchObject({ code: "INSUFFICIENT_STOCK" });
    expect(await wal.walletBalance(ctx, "DNI", DNI)).toBe(before);
  });

  it("vendedor: valida que sea del negocio y fija su porcentaje; las comisiones filtran por vendedor y fecha", async () => {
    await com.saveCommissionRate(ctx, { userId: S2, percent: "5" });
    await expect(com.saveCommissionRate(ctx, { userId: OUTSIDER, percent: "5" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(sale({ sellerId: OUTSIDER }, [{ productId: P, saleUnit: "UNIT", quantity: 2 }], [{ method: "EFECTIVO", amount: "1.00" }])).rejects.toMatchObject({ code: "INVALID_SELLER" });
    const r = await sale({ sellerId: S2 }, [{ productId: P, saleUnit: "PACKAGE", quantity: 1 }], [{ method: "EFECTIVO", amount: "80.00" }]);
    const doc = await db.document.findUniqueOrThrow({ where: { id: r.documentId } });
    expect(doc.seller_id).toBe(S2);
    expect(doc.seller_commission_percent!.toNumber()).toBe(5);
    expect(doc.created_by).toBe(U);

    // Cambiar la tasa no altera lo ya vendido
    await com.saveCommissionRate(ctx, { userId: S2, percent: "50" });
    const rep = await com.loadCommissions(ctx, today, today, S2);
    expect(rep.sellers).toHaveLength(1);
    const expected = doc.op_gravadas.plus(doc.op_exoneradas).plus(doc.op_inafectas);
    expect(rep.totalBase).toBe(expected.toFixed(2));
    expect(rep.totalCommission).toBe(expected.times("0.05").toFixed(2));
    expect((await com.loadCommissions(ctx, "2020-01-01", "2020-01-31", S2)).sellers).toHaveLength(0);
    expect((await com.loadCommissions(ctx, today, today)).sellers.map((s) => s.sellerId)).toContain(U);
    expect((await com.loadCommissions({ tenantId: T2, userId: U }, today, today)).sellers).toHaveLength(0);
  });

  it("nota de crédito: revierte monedero y comisión", async () => {
    await com.saveCommissionRate(ctx, { userId: S2, percent: "5" });
    const r = await sale({ sellerId: S2 }, [{ productId: P, saleUnit: "PACKAGE", quantity: 1 }], [{ method: "EFECTIVO", amount: "80.00" }]);
    await db.document.update({ where: { id: r.documentId }, data: { status: "ACEPTADO" } });
    const after = Number(await wal.walletBalance(ctx, "DNI", DNI));
    const item = await db.documentItem.findFirstOrThrow({ where: { document_id: r.documentId } });
    const note = await issueCreditNote(ctx, {
      idempotencyKey: randomUUID(), documentId: r.documentId, series: "BC01", reasonCode: "07", reasonText: "Devolución parcial del cliente",
      lines: [{ itemId: item.id, quantity: item.quantity.toString() }],
    });
    const nc = await db.document.findUniqueOrThrow({ where: { id: note.documentId } });
    expect(nc.seller_id).toBe(S2);
    expect(Number(await wal.walletBalance(ctx, "DNI", DNI))).toBeCloseTo(after - 8, 2);
    const rep = await com.loadCommissions(ctx, today, today, S2);
    expect(rep.sellers[0]!.lines.some((l) => l.isNote && Number(l.base) < 0)).toBe(true);
  });

  it("una devolución no paga dos veces lo que se cobró con monedero", async () => {
    const bal = Number(await wal.walletBalance(ctx, "DNI", DNI));
    const use = Math.min(bal, 5).toFixed(2);
    expect(Number(use)).toBeGreaterThan(0);
    const rest = (80 - Number(use)).toFixed(2);
    const r = await sale({}, [{ productId: P, saleUnit: "PACKAGE", quantity: 1 }], [{ method: "MONEDERO", amount: use }, { method: "EFECTIVO", amount: rest }]);
    await db.document.update({ where: { id: r.documentId }, data: { status: "ACEPTADO" } });
    const note = await issueCreditNote(ctx, { idempotencyKey: randomUUID(), documentId: r.documentId, series: "BC01", reasonCode: "07", reasonText: "Devolución total", refundMethod: "EFECTIVO" });
    const paid = await db.documentPayment.findMany({ where: { document_id: note.documentId } });
    expect(paid).toHaveLength(1);
    expect(paid[0]!.amount.toFixed(2)).toBe(rest);
    const moves = await db.walletTransaction.findMany({ where: { document_id: note.documentId, type: "REDEEM_REFUND" } });
    expect(moves[0]!.amount.toFixed(2)).toBe(use);
  });

  it("compras: exige lote y vencimiento vigentes, y rechaza un lote con otra fecha", async () => {
    const job = async () => {
      const id = randomUUID(), item = randomUUID();
      await db.$executeRawUnsafe(`INSERT INTO ai_ingestion_jobs (id, tenant_id, branch_id, source_kind, storage_path, file_sha256, mime_type, status, created_by) VALUES ('${id}', '${T}', '${B}', 'XML', 'x/${id}', '${"a".repeat(28)}${id.replaceAll("-", "").slice(0, 32)}0000', 'text/xml', 'NEEDS_REVIEW', '${U}')`);
      await db.$executeRawUnsafe(`INSERT INTO ai_ingestion_items (id, tenant_id, job_id, line_no, raw, description, quantity, unit_price, confidence) VALUES ('${item}', '${T}', '${id}', 1, '{}', 'Paracetamol x200', 2, 50, 1)`);
      return { id, item };
    };
    const approve = (j: { id: string; item: string }, lot: Record<string, string>) => approveIngestion(ctx, {
      jobId: j.id, supplier: { ruc: "20100070970", legalName: "DROGUERIA SA" },
      header: { docType: "01", series: "F001", number: String(Math.floor(Math.random() * 1e7)), issueDate: today, currency: "PEN" },
      items: [{ itemId: j.item, action: "RECEIVE", productId: P, quantity: "2", purchaseUnit: "PACKAGE", unitsPerPackage: 200, unitCostWithoutIgv: "50", ...lot }],
    } as never);
    const j = await job();
    await expect(approve(j, {})).rejects.toMatchObject({ code: "LOT_REQUIRED" });
    await expect(approve(j, { lotCode: "L9" })).rejects.toMatchObject({ code: "LOT_REQUIRED" });
    await expect(approve(j, { lotCode: "L9", expiryDate: today })).rejects.toMatchObject({ code: "LOT_REQUIRED" });
    await expect(approve(j, { lotCode: "L1", expiryDate: "2099-01-01" })).rejects.toMatchObject({ code: "LOT_EXPIRY_MISMATCH" });
    const before = await stock();
    await approve(j, { lotCode: "L9", expiryDate: "2099-01-01" });
    expect(await stock()).toBe(before + 400); // 2 cajas de 200 en unidad base
    const batch = await db.productBatch.findFirstOrThrow({ where: { product_id: P, lot_code: "L9" } });
    expect(batch.expiry_date!.toISOString().slice(0, 10)).toBe("2099-01-01");
  });

  it("DIGEMID: exporta solo productos con código y exige el del establecimiento", async () => {
    await expect(dig.observatoryRows(ctx, B)).rejects.toMatchObject({ code: "NO_ESTABLISHMENT_CODE" });
    await dig.saveEstablishmentCode(ctx, B, "0012345");
    await expect(dig.saveProductCode(ctx, P, "abc")).rejects.toMatchObject({ code: "VALIDATION" });
    expect(await dig.observatoryRows(ctx, B)).toEqual([{ establishment: "0012345", productCode: "01234", packagePrice: "80.00", unitPrice: "0.50" }]);
    await expect(dig.observatoryRows({ tenantId: T2, userId: U }, B)).rejects.toMatchObject({ code: "NOT_FOUND" });
    const rep = await dig.loadPriceReport({ ...ctx, branchIds: [] });
    expect(rep.branches[0]!.code).toBe("0012345");
  });

  it("DIGEMID: el reporte de controlados incluye lote y receta, y aísla por negocio", async () => {
    const CTRL = randomUUID(), RX = randomUUID();
    await db.$executeRawUnsafe(`INSERT INTO products (id, tenant_id, sku, name, sale_price, is_controlled, sale_condition, controlled_list) VALUES ('${CTRL}', '${T}', 'DIAZ', 'Diazepam', 1, true, 'RETAINED_PRESCRIPTION', 'IIIC')`);
    const batch = (await db.$queryRawUnsafe<{ id: string }[]>(`INSERT INTO product_batches (tenant_id, branch_id, product_id, lot_code, expiry_date, stock, unit_cost) VALUES ('${T}', '${B}', '${CTRL}', 'LC1', '2030-01-01', 10, 1) RETURNING id`))[0]!.id;
    await db.$executeRawUnsafe(`INSERT INTO prescriptions (id, tenant_id, branch_id, kind, patient_name, prescriber_name, prescriber_cmp, prescriber_doc, issued_at, retained, validated_by) VALUES ('${RX}', '${T}', '${B}', 'SPECIAL', 'Luis Vega', 'Dra. Rojas', '4567', '12345678', current_date, true, '${U}')`);
    await db.$executeRawUnsafe(`INSERT INTO controlled_substance_log (tenant_id, branch_id, product_id, batch_id, movement, quantity, balance, recorded_by) VALUES ('${T}', '${B}', '${CTRL}', '${batch}', 'IN', 10, 0, '${U}')`);
    await db.$executeRawUnsafe(`INSERT INTO controlled_substance_log (tenant_id, branch_id, product_id, batch_id, movement, quantity, balance, prescription_id, recorded_by) VALUES ('${T}', '${B}', '${CTRL}', '${batch}', 'OUT', 1, 0, '${RX}', '${U}')`);
    const rows = await dig.loadControlledReport(ctx, today, today, { audited: true });
    const out = rows.find((r) => r.movement === "Salida")!;
    expect(out).toMatchObject({ lot: "LC1", expiry: "2030-01-01", balance: "9.000", prescriber: "Dra. Rojas", prescriberDoc: "12345678", patient: "Luis Vega", list: "IIIC" });
    expect(await dig.loadControlledReport({ tenantId: T2, userId: U }, today, today)).toHaveLength(0);
    expect(await db.auditLog.count({ where: { tenant_id: T, action: "digemid.controlled_export" } })).toBe(1);
  });
});
