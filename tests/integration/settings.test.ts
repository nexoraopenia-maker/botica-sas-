/** Reglas de Configuración (sucursales, series, alertas) contra PostgreSQL real con RLS. */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const RUNTIME_URL = process.env.TEST_DATABASE_URL;
const PLATFORM_URL = process.env.TEST_PLATFORM_DATABASE_URL;
Object.assign(process.env, {
  DATABASE_URL: RUNTIME_URL ?? "postgresql://x@localhost/x",
  PLATFORM_DATABASE_URL: PLATFORM_URL ?? "postgresql://x@localhost/x",
});

const T = randomUUID();
const B = randomUUID();
const U = randomUUID();
const ctx = { tenantId: T, userId: U };

describe("Configuración del negocio (PostgreSQL)", async () => {
  const { platformDb, runtimeDb } = await import("@/lib/db");
  const svc = await import("@/lib/settings/service");
  const db = platformDb();

  beforeAll(async () => {
    const ruc = `20${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`;
    await db.$executeRawUnsafe(`INSERT INTO tenants (id, slug, ruc, legal_name, business_lines, fiscal_address, ubigeo, department, province, district, contact_email, status)
      VALUES ('${T}', 'set-${T.slice(0, 8)}', '${ruc}', 'SET TEST', '{RETAIL}', 'Av 1', '150101', 'LIMA', 'LIMA', 'LIMA', 's@t.pe', 'ACTIVE')`);
    await db.$executeRawUnsafe(`INSERT INTO branches (id, tenant_id, sunat_code, name, address, ubigeo) VALUES ('${B}', '${T}', '0000', 'Principal', 'Av 1', '150101')`);
    await db.$executeRawUnsafe(`INSERT INTO document_series (tenant_id, branch_id, doc_type, series) VALUES ('${T}', '${B}', 'BOLETA', 'B001')`);
    await db.$executeRawUnsafe(`INSERT INTO roles (tenant_id, key, name, permissions) VALUES ('${T}', 'admin', 'Administrador', '{*}')`);
    const plan = await db.plan.findFirstOrThrow({ where: { code: "profesional" } }); // max_branches = 2
    await db.subscription.create({ data: { tenant_id: T, plan_id: plan.id, status: "ACTIVE", current_period_start: new Date(), current_period_end: new Date(Date.now() + 864e5) } });
  });
  afterAll(async () => { await runtimeDb().$disconnect(); await db.$disconnect(); });

  it("crea sucursal hasta el límite del plan", async () => {
    await svc.createBranch(ctx, { sunatCode: "0001", name: "Centro", address: "Jr. Lima 100", ubigeo: "150101" });
    await expect(svc.createBranch(ctx, { sunatCode: "0002", name: "Norte", address: "Av. Norte 200", ubigeo: "150101" }))
      .rejects.toMatchObject({ code: "PLAN_LIMIT" });
  });

  it("no permite desactivar la última sucursal activa", async () => {
    const centro = await db.branch.findFirstOrThrow({ where: { tenant_id: T, sunat_code: "0001" } });
    await svc.updateBranch(ctx, { branchId: centro.id, name: "Centro", address: "Jr. Lima 100", ubigeo: "150101", isActive: false });
    await expect(svc.updateBranch(ctx, { branchId: B, name: "Principal", address: "Av. Principal 1", ubigeo: "150101", isActive: false }))
      .rejects.toMatchObject({ code: "LAST_BRANCH" });
  });

  it("series: formato, duplicados y última serie activa", async () => {
    await expect(svc.createSeries(ctx, { branchId: B, docType: "FACTURA", series: "B002" })).rejects.toThrow();
    await svc.createSeries(ctx, { branchId: B, docType: "BOLETA", series: "b002" }); // se normaliza a mayúsculas
    await expect(svc.createSeries(ctx, { branchId: B, docType: "BOLETA", series: "B002" })).rejects.toMatchObject({ code: "DUPLICATE" });
    const b001 = await db.documentSeries.findFirstOrThrow({ where: { tenant_id: T, series: "B001" } });
    const b002 = await db.documentSeries.findFirstOrThrow({ where: { tenant_id: T, series: "B002" } });
    await svc.toggleSeries(ctx, { seriesId: b001.id, isActive: false });
    await expect(svc.toggleSeries(ctx, { seriesId: b002.id, isActive: false })).rejects.toMatchObject({ code: "LAST_SERIES" });
  });

  it("alertas: guarda umbrales ordenados y valida módulos y roles", async () => {
    const modules = new Set(["CORE"]);
    await svc.saveAlertRule({ ...ctx, modules }, { kind: "BATCH_EXPIRY", enabled: true, thresholds: [15, 60, 15, 0], channels: ["IN_APP"], recipientRoles: ["admin"] });
    const rule = await db.alertRule.findFirstOrThrow({ where: { tenant_id: T, kind: "BATCH_EXPIRY" } });
    expect(rule.thresholds).toEqual([60, 15, 0]);
    await expect(svc.saveAlertRule({ ...ctx, modules }, { kind: "BATCH_EXPIRY", enabled: true, thresholds: [30], channels: ["WHATSAPP"], recipientRoles: [] }))
      .rejects.toMatchObject({ code: "MODULE_DISABLED" });
    await expect(svc.saveAlertRule({ ...ctx, modules }, { kind: "LOW_STOCK", enabled: true, thresholds: [], channels: ["IN_APP"], recipientRoles: ["no-existe"] }))
      .rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("RLS: otro tenant no puede modificar estas sucursales", async () => {
    await expect(svc.updateBranch({ tenantId: randomUUID(), userId: U }, { branchId: B, name: "Intruso", address: "Av. Principal 1", ubigeo: "150101", isActive: true }))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
