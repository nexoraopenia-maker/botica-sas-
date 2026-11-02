/** Órdenes de servicio, cobros y cobranza contra PostgreSQL real con RLS. El almacenamiento de fotos se simula. */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const uploads: { bucket: string; path: string; contentType: string }[] = [];
vi.mock("@/lib/storage", () => ({
  tenantPath: (t: string, ...p: string[]) => [t, ...p].join("/"),
  putObject: async (bucket: string, path: string, _b: Buffer, contentType: string) => { uploads.push({ bucket, path, contentType }); },
  signedUrl: async (_b: string, path: string) => `https://firmada/${path}`,
}));

Object.assign(process.env, {
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgresql://x@localhost/x",
  PLATFORM_DATABASE_URL: process.env.TEST_PLATFORM_DATABASE_URL ?? "postgresql://x@localhost/x",
});

const T = randomUUID(), T2 = randomUUID(), B = randomUUID(), B2 = randomUUID(), U = randomUUID();
const ctx = { tenantId: T, userId: U };
const ctx2 = { tenantId: T2, userId: U };
const lima = (plus = 0) => { const d = new Date(`${new Intl.DateTimeFormat("en-CA", { timeZone: "America/Lima" }).format(new Date())}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + plus); return d.toISOString().slice(0, 10); };
const JPG = () => new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4])], "x.jpg", { type: "image/jpeg" });

describe("Órdenes de servicio (PostgreSQL)", async () => {
  const { platformDb, runtimeDb, withTenant } = await import("@/lib/db");
  const svc = await import("@/lib/services/orders");
  const col = await import("@/lib/services/collections");
  const db = platformDb();
  const ruc = () => `20${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`;
  const customer = (n: string, extra = {}) => ({ docType: "DNI" as const, docNumber: n, name: "Juan Pérez", phone: "987111222", whatsappOptIn: true, ...extra });
  const base = (over = {}) => ({
    idempotencyKey: randomUUID(), branchId: B, customer: customer(String(Math.floor(1e7 + Math.random() * 8e7))),
    itemDescription: "Toyota Hilux", plate: "abc-123", problem: "Cambio de frenos", paymentType: "CASH" as const, total: "200", ...over,
  });
  const credit = (days: number, over = {}) => base({ paymentType: "CREDIT", dueDate: lima(days), ...over });
  const get = (id: string) => db.serviceOrder.findUniqueOrThrow({ where: { id } });
  const pay = (orderId: string, amount: string, caps = { canCollectCredit: true }, key = randomUUID()) =>
    svc.registerPayment(ctx, { idempotencyKey: key, orderId, amount, method: "EFECTIVO" }, caps);

  beforeAll(async () => {
    for (const [id, b] of [[T, B], [T2, B2]] as const) {
      await db.$executeRawUnsafe(`INSERT INTO tenants (id, slug, ruc, legal_name, business_lines, fiscal_address, ubigeo, department, province, district, contact_email, status)
        VALUES ('${id}', 'tl-${id.slice(0, 8)}', '${ruc()}', 'TALLER TEST', '{WORKSHOP}', 'Av 1', '150101', 'LIMA', 'LIMA', 'LIMA', 't@t.pe', 'ACTIVE')`);
      await db.$executeRawUnsafe(`INSERT INTO branches (id, tenant_id, sunat_code, name, address, ubigeo) VALUES ('${b}', '${id}', '0000', 'Principal', 'Av 1', '150101')`);
    }
    await db.$executeRawUnsafe(`INSERT INTO tenant_modules (tenant_id, module, enabled) VALUES ('${T}', 'WORKSHOP', true), ('${T}', 'WHATSAPP', true), ('${T2}', 'WORKSHOP', true)`);
    await db.whatsappSettings.create({ data: { tenant_id: T, enabled: true, reminder_days: 3 } });
  });
  afterAll(async () => { await runtimeDb().$disconnect(); await db.$disconnect(); });

  it("crea la orden con correlativo y saldo igual al total, sin duplicar con la misma clave", async () => {
    const input = base();
    const a = await svc.createOrder(ctx, input);
    const b = await svc.createOrder(ctx, input);
    expect(b).toEqual({ ...a, replayed: true });
    const o = await get(a.orderId);
    expect(o.balance_due.toFixed(2)).toBe("200.00");
    expect(o.plate).toBe("ABC-123");
    expect(o.status).toBe("RECEIVED");
    const next = await svc.createOrder(ctx, base());
    expect(next.number).toBe(a.number + 1);
  });

  it("los correlativos no se repiten con recepciones simultáneas", async () => {
    const r = await Promise.all(Array.from({ length: 6 }, () => svc.createOrder(ctx, base())));
    expect(new Set(r.map((x) => x.number)).size).toBe(6);
  });

  it("valida cliente y crédito", async () => {
    await expect(svc.createOrder(ctx, base({ customer: customer("123") }))).rejects.toThrow();
    await expect(svc.createOrder(ctx, base({ customer: customer("12345678", { phone: "", whatsappOptIn: true }) }))).rejects.toThrow();
    await expect(svc.createOrder(ctx, base({ paymentType: "CREDIT" }))).rejects.toMatchObject({ code: "DUE_DATE_REQUIRED" });
    await expect(svc.createOrder(ctx, credit(-1))).rejects.toMatchObject({ code: "DUE_DATE_PAST" });
  });

  it("otro negocio no ve ni modifica la orden", async () => {
    const { orderId } = await svc.createOrder(ctx, base());
    expect(await withTenant(ctx2, (tx) => tx.serviceOrder.findMany({ where: { id: orderId } }))).toHaveLength(0);
    await expect(svc.changeOrderStatus(ctx2, { orderId, status: "IN_PROGRESS" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(svc.registerPayment(ctx2, { idempotencyKey: randomUUID(), orderId, amount: "1", method: "EFECTIVO" }, { canCollectCredit: true })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(svc.addEvidence(ctx2, orderId, JPG())).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(svc.createOrder(ctx2, base())).rejects.toThrow(); // sucursal de otro negocio
  });

  it("el saldo no puede quedar en un valor imposible ni siquiera con SQL directo", async () => {
    const { orderId } = await svc.createOrder(ctx, base());
    await expect(db.serviceOrder.update({ where: { id: orderId }, data: { balance_due: 999 } })).rejects.toThrow();
    await expect(db.serviceOrder.update({ where: { id: orderId }, data: { balance_due: -1 } })).rejects.toThrow();
  });

  it("flujo completo al contado: no se entrega hasta cobrar", async () => {
    const { orderId } = await svc.createOrder(ctx, base());
    await expect(svc.changeOrderStatus(ctx, { orderId, status: "DELIVERED" })).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
    await svc.changeOrderStatus(ctx, { orderId, status: "IN_PROGRESS" });
    await svc.changeOrderStatus(ctx, { orderId, status: "READY" });
    await expect(svc.changeOrderStatus(ctx, { orderId, status: "DELIVERED" })).rejects.toMatchObject({ code: "CANNOT_DELIVER" });
    await pay(orderId, "200");
    await svc.changeOrderStatus(ctx, { orderId, status: "DELIVERED" });
    const o = await get(orderId);
    expect(o.delivered_at).not.toBeNull();
    await expect(svc.changeOrderStatus(ctx, { orderId, status: "READY" })).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
    await expect(svc.updateOrderTerms(ctx, { orderId, paymentType: "CASH", total: "300" })).rejects.toMatchObject({ code: "ORDER_DELIVERED" });
  });

  it("cobros: parciales, tope de saldo, permiso e idempotencia", async () => {
    const { orderId } = await svc.createOrder(ctx, credit(10));
    await expect(pay(orderId, "50", { canCollectCredit: false })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await pay(orderId, "50")).balanceDue).toBe("150.00");
    const key = randomUUID();
    expect((await pay(orderId, "30", undefined, key)).replayed).toBe(false);
    const again = await pay(orderId, "30", undefined, key);
    expect(again).toEqual({ balanceDue: "120.00", replayed: true });
    await expect(pay(orderId, "120.01")).rejects.toMatchObject({ code: "AMOUNT_EXCEEDS_BALANCE" });
    await expect(pay(orderId, "0")).rejects.toThrow();
    expect(await db.serviceOrderPayment.count({ where: { order_id: orderId } })).toBe(2);
  });

  it("dos cobros simultáneos no superan el saldo", async () => {
    const { orderId } = await svc.createOrder(ctx, credit(10));
    const r = await Promise.allSettled([pay(orderId, "150"), pay(orderId, "150")]);
    expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect((await get(orderId)).balance_due.toFixed(2)).toBe("50.00");
  });

  it("un cobro registrado no se puede modificar ni borrar", async () => {
    await expect(withTenant(ctx, (tx) => tx.serviceOrderPayment.updateMany({ data: { amount: 1 } }))).rejects.toThrow();
    await expect(withTenant(ctx, (tx) => tx.serviceOrderPayment.deleteMany())).rejects.toThrow();
  });

  it("cambiar el total respeta lo cobrado y recalcula el saldo", async () => {
    const { orderId } = await svc.createOrder(ctx, credit(10));
    await pay(orderId, "150");
    await expect(svc.updateOrderTerms(ctx, { orderId, paymentType: "CREDIT", total: "100", dueDate: lima(10) })).rejects.toMatchObject({ code: "TOTAL_BELOW_PAID" });
    await svc.updateOrderTerms(ctx, { orderId, paymentType: "CREDIT", total: "300", dueDate: lima(20), invoiceNumber: "f001-55" });
    const o = await get(orderId);
    expect(o.balance_due.toFixed(2)).toBe("150.00");
    expect(o.invoice_number).toBe("F001-55");
  });

  it("fotos: valida el contenido, usa rutas del negocio y limita a 8", async () => {
    const { orderId } = await svc.createOrder(ctx, base());
    uploads.length = 0;
    await expect(svc.addEvidence(ctx, orderId, new File(["<script>"], "foto.jpg", { type: "image/jpeg" }))).rejects.toMatchObject({ code: "INVALID_FILE" });
    expect(uploads).toHaveLength(0);
    await expect(svc.addEvidence(ctx, orderId, new File([new Uint8Array(4_000_001)], "g.jpg"))).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
    for (let i = 0; i < 8; i++) await svc.addEvidence(ctx, orderId, JPG());
    await expect(svc.addEvidence(ctx, orderId, JPG())).rejects.toMatchObject({ code: "EVIDENCE_LIMIT" });
    const o = await get(orderId);
    expect(o.evidence_urls).toHaveLength(8);
    expect(o.evidence_urls.every((p) => p.startsWith(`${T}/service-orders/${orderId}/`))).toBe(true);
    expect(uploads.every((u) => u.bucket === "tenant-files" && u.contentType === "image/jpeg")).toBe(true);
    const foreign = await svc.evidenceLinks(T2, o.evidence_urls);
    expect(foreign).toHaveLength(0); // no se firman rutas de otro negocio
    expect((await svc.evidenceLinks(T, o.evidence_urls))[0]!.url).toContain("https://firmada/");
  });

  it("semáforo: clasifica y excluye contado y saldos pagados", async () => {
    const t = randomUUID(), b = randomUUID();
    await db.$executeRawUnsafe(`INSERT INTO tenants (id, slug, ruc, legal_name, business_lines, fiscal_address, ubigeo, department, province, district, contact_email, status)
      VALUES ('${t}', 'sf-${t.slice(0, 8)}', '${ruc()}', 'SEMAFORO', '{WORKSHOP}', 'Av 1', '150101', 'LIMA', 'LIMA', 'LIMA', 's@t.pe', 'ACTIVE')`);
    await db.$executeRawUnsafe(`INSERT INTO branches (id, tenant_id, sunat_code, name, address, ubigeo) VALUES ('${b}', '${t}', '0000', 'P', 'Av 1', '150101')`);
    const c = { tenantId: t, userId: U };
    const mk = (days: number, total = "100") => svc.createOrder(c, base({ branchId: b, paymentType: "CREDIT", dueDate: lima(days), total }));
    const soon = await mk(2); await mk(30, "70.50");
    const overdue = await mk(1);
    await db.serviceOrder.update({ where: { id: overdue.orderId }, data: { due_date: new Date(`${lima(-4)}T00:00:00Z`) } });
    await svc.createOrder(c, base({ branchId: b })); // contado: no entra
    const paid = await mk(5);
    await svc.registerPayment(c, { idempotencyKey: randomUUID(), orderId: paid.orderId, amount: "100", method: "YAPE" }, { canCollectCredit: true });
    const d = await col.loadReceivables(c);
    expect(d.rows.map((r) => r.light)).toEqual(["overdue", "soon", "ok"]);
    expect(d.rows[1]!.id).toBe(soon.orderId);
    expect(d.totals).toEqual({ overdue: { amount: "100.00", count: 1 }, soon: { amount: "100.00", count: 1 }, ok: { amount: "70.50", count: 1 } });
  });

  it("cobranza: simula sin escribir, avisa una vez, respeta consentimiento y plazo", async () => {
    await db.serviceOrder.updateMany({ where: { tenant_id: T }, data: { deleted_at: new Date() } });
    const yes = await svc.createOrder(ctx, credit(2));
    await svc.createOrder(ctx, credit(2, { customer: customer("11223344", { whatsappOptIn: false }) })); // sin consentimiento
    await svc.createOrder(ctx, credit(15)); // fuera de plazo
    const paid = await svc.createOrder(ctx, credit(1));
    await pay(paid.orderId, "200"); // ya pagada

    const dry = await col.scanCollections({ tenantId: T, dryRun: true });
    expect(dry.queued).toBe(0);
    expect(dry.items).toHaveLength(1);
    expect(dry.skippedNoConsent).toBe(1);
    expect(dry.items[0]!.text).toContain("S/ 200.00");
    expect(await db.notification.count({ where: { tenant_id: T, template: "payment_due_soon" } })).toBe(0);

    const run = await col.scanCollections({ tenantId: T, dryRun: false });
    expect(run.queued).toBe(1);
    const n = await db.notification.findFirstOrThrow({ where: { tenant_id: T, template: "payment_due_soon" } });
    expect(n.related_id).toBe(yes.orderId);
    expect(n.recipient).toBe("+51987111222");
    expect(await db.outboxEvent.count({ where: { dedupe_key: `notification.send:${n.id}` } })).toBe(1);

    const again = await col.scanCollections({ tenantId: T, dryRun: false });
    expect(again.queued).toBe(0);
    expect(again.items[0]!.isNew).toBe(false);

    // Si se reprograma el vencimiento, corresponde un aviso nuevo
    await svc.updateOrderTerms(ctx, { orderId: yes.orderId, paymentType: "CREDIT", total: "200", dueDate: lima(3) });
    expect((await col.scanCollections({ tenantId: T, dryRun: false })).queued).toBe(1);
  });

  it("sin WhatsApp activo no se envía nada", async () => {
    await db.whatsappSettings.create({ data: { tenant_id: T2, enabled: true } }); // T2 no tiene el módulo WHATSAPP
    expect((await col.scanCollections({ tenantId: T2, dryRun: true })).tenants).toBe(0);
  });
});
