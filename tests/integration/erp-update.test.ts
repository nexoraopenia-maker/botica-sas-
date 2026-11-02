/** WhatsApp cifrado, cierre de caja, recordatorios y cartilla contra PostgreSQL real con RLS. */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const RUNTIME_URL = process.env.TEST_DATABASE_URL;
const PLATFORM_URL = process.env.TEST_PLATFORM_DATABASE_URL;
Object.assign(process.env, {
  DATABASE_URL: RUNTIME_URL ?? "postgresql://x@localhost/x",
  PLATFORM_DATABASE_URL: PLATFORM_URL ?? "postgresql://x@localhost/x",
});

const T = randomUUID(), B = randomUUID(), U = randomUUID(), U2 = randomUUID(), PET = randomUUID(), OWNER = randomUUID(), PROD = randomUUID(), BATCH = randomUUID();
const OTHER = randomUUID();
const ctx = { tenantId: T, userId: U };

describe("Actualización ERP (PostgreSQL)", async () => {
  const { platformDb, runtimeDb, withTenant } = await import("@/lib/db");
  const wa = await import("@/lib/whatsapp/settings");
  const secrets = await import("@/lib/platform/tenant-secrets");
  const cash = await import("@/lib/pos/cash-closure");
  const rem = await import("@/lib/whatsapp/reminders");
  const card = await import("@/lib/vet/cartilla");
  const records = await import("@/lib/vet/records");
  const ple = await import("@/lib/reports/ple");
  const db = platformDb();
  const ruc = () => `20${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`;

  async function sale(method: string, amount: string, createdBy = U) {
    const id = randomUUID();
    await db.$executeRawUnsafe(`INSERT INTO documents (id, tenant_id, branch_id, doc_type, series, number, issue_date, issue_time, customer_doc_type, customer_doc_number, customer_name, op_gravadas, igv, total, status, created_by)
      VALUES ('${id}', '${T}', '${B}', 'BOLETA', 'B001', ${Math.floor(Math.random() * 1e8)}, (now() AT TIME ZONE 'America/Lima')::date, '10:00:00', 'NO_DOC', '-', 'CLIENTES VARIOS', ${amount}, 0, ${amount}, 'ACEPTADO', '${createdBy}')`);
    await db.$executeRawUnsafe(`INSERT INTO document_payments (tenant_id, document_id, method, amount) VALUES ('${T}', '${id}', '${method}', ${amount})`);
  }

  beforeAll(async () => {
    for (const [id, name] of [[T, "ERP"], [OTHER, "OTRO"]] as const) {
      await db.$executeRawUnsafe(`INSERT INTO tenants (id, slug, ruc, legal_name, business_lines, fiscal_address, ubigeo, department, province, district, contact_email, contact_phone, status)
        VALUES ('${id}', 'erp-${id.slice(0, 8)}', '${ruc()}', '${name} TEST', '{VETERINARY}', 'Av 1', '150101', 'LIMA', 'LIMA', 'LIMA', 'e@t.pe', '987654321', 'ACTIVE')`);
    }
    await db.$executeRawUnsafe(`INSERT INTO branches (id, tenant_id, sunat_code, name, address, ubigeo) VALUES ('${B}', '${T}', '0000', 'Principal', 'Av 1', '150101')`);
    await db.$executeRawUnsafe(`INSERT INTO document_series (tenant_id, branch_id, doc_type, series) VALUES ('${T}', '${B}', 'BOLETA', 'B001')`);
    await db.$executeRawUnsafe(`INSERT INTO tenant_modules (tenant_id, module, enabled) VALUES ('${T}', 'WHATSAPP', true), ('${T}', 'VETERINARY', true)`);
    await db.$executeRawUnsafe(`INSERT INTO owners (id, tenant_id, full_name, whatsapp) VALUES ('${OWNER}', '${T}', 'Ana Dueña', '+51987111222')`);
    await db.$executeRawUnsafe(`INSERT INTO pets (id, tenant_id, owner_id, name, species) VALUES ('${PET}', '${T}', '${OWNER}', 'Firulais', 'CANINE')`);
    const vac = randomUUID();
    await db.$executeRawUnsafe(`INSERT INTO vaccine_catalog (id, tenant_id, species, name, kind, first_dose_min_age_days, primary_doses, primary_interval_days, booster_interval_days) VALUES ('${vac}', '${T}', 'CANINE', 'Rabia ${vac.slice(0, 6)}', 'RABIES', 90, 1, 21, 365)`);
    await db.$executeRawUnsafe(`INSERT INTO pet_vaccinations (tenant_id, pet_id, vaccine_id, dose_number, applied_at, next_due_at) VALUES ('${T}', '${PET}', '${vac}', 1, current_date - 362, (now() AT TIME ZONE 'America/Lima')::date + 2)`);
    await db.$executeRawUnsafe(`INSERT INTO products (id, tenant_id, sku, name, sale_price) VALUES ('${PROD}', '${T}', 'P${PROD.slice(0, 6)}', 'Amoxicilina', 10)`);
    await db.$executeRawUnsafe(`INSERT INTO product_batches (id, tenant_id, branch_id, product_id, lot_code, expiry_date, stock, unit_cost) VALUES ('${BATCH}', '${T}', '${B}', '${PROD}', 'L1', (now() AT TIME ZONE 'America/Lima')::date + 2, 5, 1)`);
  });
  afterAll(async () => { await runtimeDb().$disconnect(); await db.$disconnect(); });

  it("el token de WhatsApp se guarda cifrado y solo se recupera con su negocio", async () => {
    const TOKEN = "EAAG-secreto-de-prueba-1234";
    await wa.saveWhatsappSettings(ctx, { provider: "META_CLOUD", wabaId: "1234567", phoneNumberId: "7654321", token: TOKEN, enabled: true, reminderDays: 3 });
    const row = await db.tenantSecret.findFirstOrThrow({ where: { tenant_id: T, kind: "WHATSAPP_TOKEN", is_active: true } });
    expect(Buffer.from(row.ciphertext).toString("utf8")).not.toContain(TOKEN);
    expect(await secrets.loadWhatsappToken(T)).toBe(TOKEN);
    expect(row.fingerprint).toBe("••••1234");
    const status = await wa.getWhatsappStatus(T, false);
    expect(JSON.stringify(status)).not.toContain(TOKEN);
    expect(status.tokenMask).toBe("••••1234");
    // El ciphertext copiado a otro negocio no descifra (AAD)
    await db.tenantSecret.create({ data: { tenant_id: OTHER, kind: "WHATSAPP_TOKEN", ciphertext: row.ciphertext, iv: row.iv, auth_tag: row.auth_tag, wrapped_dek: row.wrapped_dek, kek_id: row.kek_id } });
    await expect(secrets.loadWhatsappToken(OTHER)).rejects.toThrow();
  });

  it("guardar sin token conserva el anterior; la auditoría no lo contiene", async () => {
    await wa.saveWhatsappSettings(ctx, { provider: "META_CLOUD", wabaId: "1234567", phoneNumberId: "7654321", enabled: true, reminderDays: 3 });
    expect(await secrets.loadWhatsappToken(T)).toBe("EAAG-secreto-de-prueba-1234");
    const logs = await db.auditLog.findMany({ where: { tenant_id: T, action: "whatsapp.settings" } });
    expect(logs.length).toBe(2);
    expect(JSON.stringify(logs.map((l) => l.after))).not.toContain("EAAG");
  });

  it("el rol de runtime no puede leer los secretos ni la configuración de otro negocio", async () => {
    await expect(withTenant(ctx, (tx) => tx.tenantSecret.findMany())).rejects.toThrow();
    const other = await withTenant({ tenantId: OTHER, userId: U }, (tx) => tx.whatsappSettings.findMany());
    expect(other).toHaveLength(0);
  });

  it("simular no envía ni registra nada; ejecutar encola una sola vez", async () => {
    const dry = await rem.scanReminders({ tenantId: T, dryRun: true });
    expect(dry.queued).toBe(0);
    expect(dry.items.map((i) => i.kind).sort()).toEqual(["stock", "vaccine"]);
    expect(await db.notification.count({ where: { tenant_id: T, channel: "WHATSAPP" } })).toBe(0);

    const run = await rem.scanReminders({ tenantId: T, dryRun: false });
    expect(run.queued).toBe(2);
    const notes = await db.notification.findMany({ where: { tenant_id: T, channel: "WHATSAPP" } });
    expect(notes.map((n) => n.template).sort()).toEqual(["stock_expiring", "vaccine_due_soon"]);
    expect(notes.find((n) => n.template === "vaccine_due_soon")!.recipient).toBe("+51987111222");
    expect(await db.outboxEvent.count({ where: { tenant_id: T, event_type: "notification.send" } })).toBe(2);

    const again = await rem.scanReminders({ tenantId: T, dryRun: false });
    expect(again.queued).toBe(0);
    expect(again.items.every((i) => !i.isNew)).toBe(true);
    expect(await db.notification.count({ where: { tenant_id: T, channel: "WHATSAPP" } })).toBe(2);
  });

  it("un negocio sin el módulo WhatsApp no recibe recordatorios", async () => {
    await db.whatsappSettings.create({ data: { tenant_id: OTHER, enabled: true } });
    expect((await rem.scanReminders({ tenantId: OTHER, dryRun: true })).tenants).toBe(0);
  });

  it("cierre de caja: esperado por medio, descuadre con motivo obligatorio e idempotencia", async () => {
    await sale("EFECTIVO", "50.00");
    await sale("YAPE", "20.00");
    await sale("TRANSFERENCIA", "5.00");
    await sale("EFECTIVO", "99.00", U2); // otro cajero: no entra en este arqueo
    const s = await cash.getCashSummary(ctx, B);
    expect(Number(s.sales.EFECTIVO)).toBe(50);
    expect(Number(s.sales.YAPE)).toBe(20);
    expect(s.others).toEqual([{ method: "TRANSFERENCIA", total: "5.00" }]);
    expect(s.documents).toBe(3);

    const key = randomUUID();
    const input = { idempotencyKey: key, branchId: B, opening: "100", counted: { EFECTIVO: "145", YAPE: "20", PLIN: "0", TARJETA: "0" } };
    await expect(cash.closeCash(ctx, input)).rejects.toMatchObject({ code: "NOTES_REQUIRED" });
    const r = await cash.closeCash(ctx, { ...input, notes: "Faltante de S/ 5" });
    expect(r.difference).toBe("-5.00");
    expect(r.replayed).toBe(false);
    expect((await cash.closeCash(ctx, { ...input, notes: "Faltante de S/ 5" })).replayed).toBe(true);
    expect(await db.cashClosure.count({ where: { tenant_id: T } })).toBe(1);
    // El siguiente turno empieza después del cierre
    expect(Number((await cash.getCashSummary(ctx, B)).sales.EFECTIVO)).toBe(0);
  });

  it("exige contar los cuatro medios de pago", async () => {
    await expect(cash.closeCash(ctx, { idempotencyKey: randomUUID(), branchId: B, opening: 0, counted: { EFECTIVO: "1", YAPE: "0", PLIN: "0" } as never })).rejects.toThrow();
  });

  it("un cierre no se puede modificar ni borrar desde la aplicación", async () => {
    await expect(withTenant(ctx, (tx) => tx.cashClosure.updateMany({ data: { difference: 0 } }))).rejects.toThrow();
    await expect(withTenant(ctx, (tx) => tx.cashClosure.deleteMany())).rejects.toThrow();
  });

  it("historia clínica con paciente nuevo; un paciente de otro negocio no existe", async () => {
    const r = await records.createMedicalRecord(ctx, {
      branchId: B, visitType: "CONSULTATION", reason: "Control anual",
      newPatient: { ownerName: "Luis Pérez", ownerWhatsapp: "987654000", petName: "Michi", species: "FELINE", sex: "FEMALE" },
    });
    const pet = await db.pet.findUniqueOrThrow({ where: { id: r.petId }, include: { owner: true } });
    expect(pet.owner.whatsapp).toBe("+51987654000");
    await expect(records.createMedicalRecord({ tenantId: OTHER, userId: U }, { branchId: B, visitType: "CONTROL", reason: "Intento", petId: PET }))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("cartilla: PDF válido con firma verificable, sin datos del propietario", async () => {
    const data = await card.loadCartilla(PET, T);
    expect(data!.pet.name).toBe("Firulais");
    expect(JSON.stringify(data)).not.toContain("Ana Dueña");
    expect(await card.loadCartilla(PET, OTHER)).toBeNull();
    const token = card.cartillaToken(PET);
    expect(card.verifyCartillaToken(token)).toBe(PET);
    expect(card.verifyCartillaToken(`${randomUUID()}.${token.split(".")[1]}`)).toBeNull();
    expect(card.verifyCartillaToken("basura")).toBeNull();
    const pdf = await card.renderCartillaPdf(data!, `https://x/cartilla/${token}`);
    expect(Buffer.from(pdf).subarray(0, 5).toString()).toBe("%PDF-");
    expect(pdf.length).toBeGreaterThan(1000);
  });

  it("PLE: archivo de ventas del periodo con 35 campos y constancia de exportación", async () => {
    const period = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Lima" }).format(new Date()).slice(0, 7);
    const f = await ple.buildPleFile(ctx, { ruc: "20123456789" }, "sales", period);
    expect(f.count).toBe(4);
    expect(f.fileName).toMatch(/^LE20123456789\d{6}00140100001111\.TXT$/);
    const lines = f.content.toString("latin1").trim().split("\r\n");
    for (const l of lines) expect(l.slice(0, -1).split("|")).toHaveLength(35);
    expect(await db.auditLog.count({ where: { tenant_id: T, action: "ple.export" } })).toBe(1);
    const empty = await ple.buildPleFile(ctx, { ruc: "20123456789" }, "purchases", period);
    expect(empty.fileName).toMatch(/080100001011\.TXT$/);
    await expect(ple.buildPleFile(ctx, { ruc: "20123456789" }, "sales", "2026-13")).rejects.toMatchObject({ code: "VALIDATION" });
  });
});
