/** FEFO, bloqueo de lotes vencidos, mermas y panel de lotes críticos contra PostgreSQL real con RLS. */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SYSTEM_ROLES } from "@/lib/auth/permissions";
import { suggestLot } from "@/lib/inventory/expiry-rules";

Object.assign(process.env, {
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgresql://x@localhost/x",
  PLATFORM_DATABASE_URL: process.env.TEST_PLATFORM_DATABASE_URL ?? "postgresql://x@localhost/x",
});

const T = randomUUID(), T2 = randomUUID(), B = randomUUID(), B2 = randomUUID(), U = randomUUID();
const PA = randomUUID(), PE = randomUUID(), PQ = randomUUID(), PO = randomUUID(), PT = randomUUID(), PY = randomUUID(), PC = randomUUID();
const OLD = randomUUID(), MID = randomUUID(), NEW = randomUUID(), EXP = randomUUID(), QUA = randomUUID(), EMPTY = randomUUID();
const TODAY_LOT = randomUUID(), YDAY_LOT = randomUUID(), ONLY_EXP = randomUUID(), OTHER_PROD = randomUUID(), OTHER_BRANCH = randomUUID(), CTRL = randomUUID();
const ctx = { tenantId: T, userId: U };
const caps = { canOverridePrice: false, canDispenseRx: false, pharmacyEnabled: false };
const PHARMACIST = { ...ctx, permissions: SYSTEM_ROLES.pharmacist!.permissions as readonly string[] };
const WAREHOUSE = { ...ctx, permissions: SYSTEM_ROLES.warehouse!.permissions as readonly string[] };

describe("FEFO, vencidos y mermas (PostgreSQL)", async () => {
  const { platformDb, runtimeDb } = await import("@/lib/db");
  const { createSale } = await import("@/lib/inventory/pos");
  const { loadPosContext } = await import("@/lib/inventory/pos-catalog");
  const { registerWaste, CONTROLLED_WASTE_MESSAGE } = await import("@/lib/inventory/waste");
  const { loadExpiryOverview, criticalLotCount } = await import("@/lib/inventory/expiry");
  const db = platformDb();
  const ruc = () => `20${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`;
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Lima" }).format(new Date());
  const lima = (days: number) => `(now() AT TIME ZONE 'America/Lima')::date + ${days}`;
  const stock = async (batch: string) => (await db.productBatch.findUniqueOrThrow({ where: { id: batch } })).stock.toNumber();
  const batch = (id: string, product: string, lot: string, days: number, qty: number, extra = "", branch = B, received = "now()") =>
    db.$executeRawUnsafe(`INSERT INTO product_batches (id, tenant_id, branch_id, product_id, lot_code, expiry_date, stock, unit_cost, received_at ${extra ? ", is_quarantined" : ""})
      VALUES ('${id}', '${T}', '${branch}', '${product}', '${lot}', ${lima(days)}, ${qty}, 2, ${received} ${extra ? `, ${extra}` : ""})`);
  const sale = (productId: string, quantity: number, preferredBatchId?: string, key = randomUUID()) =>
    createSale(ctx, {
      idempotencyKey: key, branchId: B, docType: "BOLETA", series: "B001", customer: { docType: "NO_DOC", docNumber: "-", name: "CLIENTES VARIOS" },
      items: [{ productId, saleUnit: "UNIT", quantity, preferredBatchId }], payments: [{ method: "EFECTIVO", amount: quantity.toFixed(2) }], paymentTerms: "Contado",
    } as never, caps);
  const waste = (c: typeof ctx & { permissions?: readonly string[] }, batchId: string, quantity: number | string, reason: "EXPIRED" | "DAMAGED" | "RECALL" | "OTHER", key = randomUUID()) =>
    registerWaste(c, { idempotencyKey: key, batchId, quantity, reason, note: "Retirado de exhibición" });
  const movementsOf = (ref: string) => db.stockMovement.findMany({ where: { ref_id: ref }, orderBy: { id: "asc" } });

  beforeAll(async () => {
    for (const id of [T, T2]) {
      await db.$executeRawUnsafe(`INSERT INTO tenants (id, slug, ruc, legal_name, business_lines, fiscal_address, ubigeo, department, province, district, contact_email, status)
        VALUES ('${id}', 'lot-${id.slice(0, 8)}', '${ruc()}', 'BOTICA TEST', '{PHARMACY}', 'Av 1', '150101', 'LIMA', 'LIMA', 'LIMA', 'b@t.pe', 'ACTIVE')`);
    }
    await db.$executeRawUnsafe(`INSERT INTO branches (id, tenant_id, sunat_code, name, address, ubigeo) VALUES ('${B}', '${T}', '0000', 'Principal', 'Av 1', '150101'), ('${B2}', '${T}', '0001', 'Sucursal 2', 'Av 2', '150101')`);
    await db.$executeRawUnsafe(`INSERT INTO document_series (tenant_id, branch_id, doc_type, series) VALUES ('${T}', '${B}', 'BOLETA', 'B001')`);
    await db.$executeRawUnsafe(`INSERT INTO users (id, email, full_name) VALUES ('${U}', '${U}@t.pe', 'Cajero')`);
    for (const [id, sku, name] of [[PA, "AMOX", "Amoxicilina"], [PE, "SOLOV", "Solo vencido"], [PQ, "CUAR", "Cuarentena"], [PO, "OTRO", "Otro producto"], [PT, "HOY", "Vence hoy"], [PY, "AYER", "Venció ayer"]]) {
      await db.$executeRawUnsafe(`INSERT INTO products (id, tenant_id, sku, name, sale_price) VALUES ('${id}', '${T}', '${sku}', '${name}', 1)`);
    }
    await db.$executeRawUnsafe(`INSERT INTO products (id, tenant_id, sku, name, sale_price, is_controlled, sale_condition) VALUES ('${PC}', '${T}', 'DIAZ', 'Diazepam', 1, true, 'RETAINED_PRESCRIPTION')`);
    // FEFO: ingresó primero el que vence último, para que el orden de ingreso no coincida con el de vencimiento
    await batch(NEW, PA, "L-NEW", 400, 5, "", B, "now() - interval '3 days'");
    await batch(MID, PA, "L-MID", 100, 5, "", B, "now() - interval '2 days'");
    await batch(OLD, PA, "L-OLD", 10, 5, "", B, "now() - interval '1 day'");
    await batch(EXP, PA, "L-EXP", -1, 7);
    await batch(ONLY_EXP, PE, "L-VENC", -5, 3);
    await batch(QUA, PQ, "L-QUA", 200, 4, "true");
    await batch(EMPTY, PO, "L-VACIO", 200, 0);
    await batch(OTHER_PROD, PO, "L-OTRO", 200, 9);
    await batch(OTHER_BRANCH, PA, "L-SUC2", 300, 9, "", B2);
    await batch(TODAY_LOT, PT, "L-HOY", 0, 2);
    await batch(YDAY_LOT, PY, "L-AYER", -1, 2);
    await batch(CTRL, PC, "L-CTRL", 15, 10);
    await db.$executeRawUnsafe(`INSERT INTO controlled_substance_log (tenant_id, branch_id, product_id, batch_id, movement, quantity, balance, recorded_by) VALUES ('${T}', '${B}', '${PC}', '${CTRL}', 'IN', 10, 0, '${U}')`);
  });
  afterAll(async () => { await runtimeDb().$disconnect(); await db.$disconnect(); });

  it("el catálogo de la caja trae los lotes: vendibles en orden FEFO primero, vencidos al final y marcados", async () => {
    const pos = await loadPosContext({ ...ctx, branchIds: [B] });
    const lots = pos!.products.find((p) => p.id === PA)!.lots;
    expect(lots.map((l) => l.code)).toEqual(["L-OLD", "L-MID", "L-NEW", "L-EXP"]);
    expect(lots.find((l) => l.code === "L-OLD")).toMatchObject({ expiry: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), stock: "5.000", quarantined: false });
    expect(suggestLot(lots, today)?.code).toBe("L-OLD"); // no el último en ingresar ni el de mayor stock
    expect(lots.some((l) => l.code === "L-SUC2")).toBe(false); // lotes de otra sucursal no se ofrecen
    const quarantined = pos!.products.find((p) => p.id === PQ)!.lots;
    expect(quarantined[0]).toMatchObject({ code: "L-QUA", quarantined: true });
    expect(suggestLot(quarantined, today)).toBeNull();
  });

  it("la venta sale del lote que vence antes y completa con el siguiente (FEFO)", async () => {
    const r = await sale(PA, 7);
    const used = new Map((await movementsOf(r.documentId)).map((m) => [m.batch_id, m.quantity.toNumber()]));
    expect(used.get(OLD)).toBe(-5);
    expect(used.get(MID)).toBe(-2);
    expect(used.has(NEW)).toBe(false);
    expect([await stock(OLD), await stock(MID), await stock(NEW), await stock(EXP)]).toEqual([0, 3, 5, 7]); // el vencido no se toca
  });

  it("un lote elegido a mano se vende primero; si no alcanza, el resto sale por FEFO", async () => {
    const a = await sale(PA, 2, NEW);
    expect((await movementsOf(a.documentId)).map((m) => [m.batch_id, m.quantity.toNumber()])).toEqual([[NEW, -2]]);
    const b = await sale(PA, 5, MID); // MID tiene 3: salen 3 de MID y 2 del siguiente vendible
    const used = new Map((await movementsOf(b.documentId)).map((m) => [m.batch_id, m.quantity.toNumber()]));
    expect(used.get(MID)).toBe(-3);
    expect(used.get(NEW)).toBe(-2);
    expect(await stock(EXP)).toBe(7);
  });

  it("rechaza elegir un lote vencido, sin vender nada ni tocar el stock", async () => {
    const docs = await db.document.count({ where: { tenant_id: T } });
    const before = [await stock(EXP), await stock(NEW)];
    await expect(sale(PA, 1, EXP)).rejects.toMatchObject({ code: "EXPIRED_LOT", message: expect.stringContaining("L-EXP") });
    expect(await db.document.count({ where: { tenant_id: T } })).toBe(docs);
    expect([await stock(EXP), await stock(NEW)]).toEqual(before);
  });

  it("rechaza lotes en cuarentena, agotados, de otro producto o de otra sucursal", async () => {
    await expect(sale(PQ, 1, QUA)).rejects.toMatchObject({ code: "QUARANTINED_LOT" });
    await expect(sale(PO, 1, EMPTY)).rejects.toMatchObject({ code: "LOT_EMPTY" });
    await expect(sale(PA, 1, OTHER_PROD)).rejects.toMatchObject({ code: "LOT_INVALID" });
    await expect(sale(PA, 1, OTHER_BRANCH)).rejects.toMatchObject({ code: "LOT_INVALID" });
    await expect(sale(PA, 1, randomUUID())).rejects.toMatchObject({ code: "LOT_INVALID" });
  });

  it("un producto con solo lotes vencidos o en cuarentena no se puede vender", async () => {
    await expect(sale(PE, 1)).rejects.toMatchObject({ code: "INSUFFICIENT_STOCK" });
    await expect(sale(PQ, 1)).rejects.toMatchObject({ code: "INSUFFICIENT_STOCK" });
    expect(await stock(ONLY_EXP)).toBe(3);
  });

  it("el último día de vigencia todavía se vende; al día siguiente, no", async () => {
    await expect(sale(PT, 1)).resolves.toMatchObject({ total: "1.00" });
    await expect(sale(PY, 1)).rejects.toMatchObject({ code: "INSUFFICIENT_STOCK" });
    expect(await stock(YDAY_LOT)).toBe(2);
  });

  it("registrar una merma por vencimiento baja el stock y deja kardex, costo y auditoría", async () => {
    const r = await waste(WAREHOUSE, EXP, 7, "EXPIRED");
    expect(r).toMatchObject({ product: "Amoxicilina", lot: "L-EXP", quantity: "7", balance: "0", value: "14.00", replayed: false });
    expect(await stock(EXP)).toBe(0);
    const m = await db.stockMovement.findFirstOrThrow({ where: { batch_id: EXP, type: "WASTE" } });
    expect(m).toMatchObject({ created_by: U, ref_type: "waste", note: "Vencido: Retirado de exhibición" });
    expect([m.quantity.toNumber(), m.balance_after.toNumber(), m.unit_cost!.toNumber()]).toEqual([-7, 0, 2]);
    const audit = await db.$queryRawUnsafe<{ action: string; reason: string; after: Record<string, unknown>; before: Record<string, unknown> }[]>(
      `SELECT action, reason, after, before FROM audit_logs WHERE tenant_id = '${T}' AND entity_id = '${EXP}' AND action = 'inventory.waste'`);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ reason: "Retirado de exhibición", before: { stock: "7" }, after: { stock: "0", reason: "EXPIRED", lot: "L-EXP", product: "Amoxicilina", value: "14.00", expired: true } });
    // Y el vencido sin stock ya no aparece como crítico
    expect((await loadExpiryOverview(ctx, [], "criticos")).rows.map((x) => x.batch_id)).not.toContain(EXP);
  });

  it("valida la merma: no vencido con motivo «Vencido», más de lo que hay, fracciones y lote ajeno", async () => {
    await expect(waste(WAREHOUSE, NEW, 1, "EXPIRED")).rejects.toMatchObject({ code: "VALIDATION", message: expect.stringContaining("no está vencido") });
    await expect(waste(WAREHOUSE, NEW, 999, "DAMAGED")).rejects.toMatchObject({ code: "INSUFFICIENT_STOCK" });
    await expect(waste(WAREHOUSE, NEW, "0.5", "DAMAGED")).rejects.toMatchObject({ code: "VALIDATION", message: expect.stringContaining("fraccion") });
    await expect(waste(WAREHOUSE, NEW, 0, "DAMAGED")).rejects.toThrow();
    await expect(registerWaste(WAREHOUSE, { idempotencyKey: randomUUID(), batchId: NEW, quantity: 1, reason: "DAMAGED", note: "no" })).rejects.toThrow(); // detalle muy corto
    await expect(waste({ tenantId: T2, userId: U, permissions: ["*"] }, NEW, 1, "DAMAGED")).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await stock(NEW)).toBe(1); // 5 − 2 de la venta elegida − 2 de la venta mixta; nada de las mermas rechazadas
  });

  it("repetir la merma con la misma clave no descuenta dos veces", async () => {
    const key = randomUUID();
    const a = await waste(WAREHOUSE, OTHER_BRANCH, 2, "DAMAGED", key);
    const b = await waste(WAREHOUSE, OTHER_BRANCH, 2, "DAMAGED", key);
    expect(b).toMatchObject({ replayed: true, movementId: a.movementId, quantity: "2", product: "Amoxicilina" });
    expect(await stock(OTHER_BRANCH)).toBe(7);
    expect(await db.stockMovement.count({ where: { ref_id: key } })).toBe(1);
  });

  it("la merma de un controlado exige al farmacéutico y también sale del libro de controlados", async () => {
    await expect(waste(WAREHOUSE, CTRL, 4, "DAMAGED")).rejects.toMatchObject({ code: "FORBIDDEN", message: CONTROLLED_WASTE_MESSAGE });
    await expect(waste(ctx, CTRL, 4, "DAMAGED")).rejects.toMatchObject({ code: "FORBIDDEN" }); // sin permisos en la sesión: niega
    expect(await stock(CTRL)).toBe(10);
    expect(await db.controlledSubstanceLog.count({ where: { batch_id: CTRL, movement: "OUT" } })).toBe(0);

    await waste(PHARMACIST, CTRL, 4, "DAMAGED");
    expect(await stock(CTRL)).toBe(6);
    const out = await db.controlledSubstanceLog.findFirstOrThrow({ where: { batch_id: CTRL, movement: "OUT" } });
    expect(out).toMatchObject({ counterparty: "Merma: Dañado o roto", recorded_by: U });
    expect([out.quantity.toNumber(), out.balance.toNumber()]).toEqual([4, 6]); // el saldo del libro sigue al stock
  });

  it("el panel de críticos lista vencidos y ≤ 30 días, deja fuera lo que vence después y respeta la sucursal", async () => {
    await batch(randomUUID(), PO, "L-D30", 30, 3);
    await batch(randomUUID(), PO, "L-D31", 31, 3);
    await batch(randomUUID(), PO, "L-D75", 75, 3);
    await batch(randomUUID(), PA, "L-SUC2-C", 5, 3, "", B2);
    const crit = await loadExpiryOverview(ctx, [], "criticos");
    const lots = crit.rows.map((r) => r.lot_code);
    expect(lots).toEqual(expect.arrayContaining(["L-D30", "L-VENC", "L-AYER", "L-HOY", "L-CTRL", "L-SUC2-C"]));
    expect(lots).not.toContain("L-D31");
    expect(lots).not.toContain("L-D75");
    expect(lots).not.toContain("L-NEW");
    expect(crit.rows.find((r) => r.lot_code === "L-VENC")).toMatchObject({ bucket: "EXPIRED", is_controlled: false });
    expect(crit.rows.find((r) => r.lot_code === "L-CTRL")!.is_controlled).toBe(true);
    expect(crit.expired.lots).toBe(2); // L-VENC (3 × S/ 2) y L-AYER (2 × S/ 2); L-EXP ya se dio de baja
    expect(Number(crit.expired.value)).toBe(10);
    expect(crit.critical.lots).toBe(4); // L-HOY, L-CTRL, L-D30 y L-SUC2-C
    expect(Number(crit.critical.value)).toBe(2 + 12 + 6 + 6);
    expect(await criticalLotCount(ctx, [])).toBe(crit.expired.lots + crit.critical.lots);

    const all = await loadExpiryOverview(ctx, [], "todos");
    expect(all.rows.map((r) => r.lot_code)).toEqual(expect.arrayContaining(["L-D31", "L-D75"]));
    expect(all.rows.map((r) => r.lot_code)).not.toContain("L-NEW"); // vence en 400 días

    const other = await loadExpiryOverview(ctx, [B2], "criticos");
    expect(other.rows.map((r) => r.lot_code)).toEqual(["L-SUC2-C"]);
    expect(other.rows.every((r) => r.branch_id === B2)).toBe(true);
    expect(await criticalLotCount(ctx, [B2])).toBe(1);
    expect((await loadExpiryOverview(ctx, [B], "criticos")).rows.map((r) => r.lot_code)).not.toContain("L-SUC2-C");
    expect(await criticalLotCount({ tenantId: T2, userId: U }, [])).toBe(0); // aislado por negocio
  });

  it("las mermas del panel muestran quién, cuánto y cuánto costó", async () => {
    const o = await loadExpiryOverview(ctx, [], "criticos");
    const mine = o.recentWaste.filter((w) => w.lot === "L-EXP");
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ product: "Amoxicilina", quantity: "7.000", value: "14.00", user: "Cajero", note: "Vencido: Retirado de exhibición" });
    expect(Number(o.wasteValue30d)).toBe(14 + 4 + 8); // vencido L-EXP + dañado en la otra sucursal + controlado
  });
});
