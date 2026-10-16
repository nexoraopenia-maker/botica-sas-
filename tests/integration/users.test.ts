/** Reglas de usuarios del negocio (cambios de rol/estado) contra PostgreSQL real con RLS. */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

Object.assign(process.env, {
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgresql://x@localhost/x",
  PLATFORM_DATABASE_URL: process.env.TEST_PLATFORM_DATABASE_URL ?? "postgresql://x@localhost/x",
});

const T = randomUUID();
const ADMIN = randomUUID();
const CASHIER = randomUUID();

describe("Usuarios del negocio (PostgreSQL)", async () => {
  const { platformDb, runtimeDb } = await import("@/lib/db");
  const { updateMember } = await import("@/lib/settings/users");
  const db = platformDb();
  let adminMember = "";
  let cashierMember = "";

  beforeAll(async () => {
    const ruc = `20${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`;
    await db.$executeRawUnsafe(`INSERT INTO tenants (id, slug, ruc, legal_name, business_lines, fiscal_address, ubigeo, department, province, district, contact_email, status)
      VALUES ('${T}', 'usr-${T.slice(0, 8)}', '${ruc}', 'USR TEST', '{RETAIL}', 'Av 1', '150101', 'LIMA', 'LIMA', 'LIMA', 'u@t.pe', 'ACTIVE')`);
    const roles = await Promise.all(["admin", "cashier"].map((key) => db.role.create({ data: { tenant_id: T, key, name: key, permissions: key === "admin" ? ["*"] : ["pos.sell"] } })));
    for (const [id, email] of [[ADMIN, `a-${T}@t.pe`], [CASHIER, `c-${T}@t.pe`]] as const) await db.user.create({ data: { id, email, full_name: email } });
    adminMember = (await db.tenantUser.create({ data: { tenant_id: T, user_id: ADMIN, role_id: roles[0]!.id, status: "ACTIVE" } })).id;
    cashierMember = (await db.tenantUser.create({ data: { tenant_id: T, user_id: CASHIER, role_id: roles[1]!.id, status: "ACTIVE" } })).id;
  });
  afterAll(async () => { await runtimeDb().$disconnect(); await db.$disconnect(); });

  const asAdmin = { tenantId: T, userId: ADMIN };

  it("cambia rol y desactiva a otro usuario", async () => {
    await updateMember(asAdmin, { memberId: cashierMember, roleKey: "cashier", branchIds: [], status: "DISABLED" });
    expect((await db.tenantUser.findUniqueOrThrow({ where: { id: cashierMember } })).status).toBe("DISABLED");
  });

  it("no permite quitarse a sí mismo el rol de admin ni el acceso", async () => {
    await expect(updateMember(asAdmin, { memberId: adminMember, roleKey: "cashier", branchIds: [], status: "ACTIVE" })).rejects.toMatchObject({ code: "SELF_LOCKOUT" });
    await expect(updateMember(asAdmin, { memberId: adminMember, roleKey: "admin", branchIds: [], status: "DISABLED" })).rejects.toMatchObject({ code: "SELF_LOCKOUT" });
  });

  it("siempre queda al menos un administrador activo", async () => {
    // Otro admin (el cajero promovido) intenta degradar al único admin restante
    await updateMember(asAdmin, { memberId: cashierMember, roleKey: "admin", branchIds: [], status: "ACTIVE" });
    await updateMember({ tenantId: T, userId: CASHIER }, { memberId: adminMember, roleKey: "cashier", branchIds: [], status: "ACTIVE" });
    await expect(updateMember({ tenantId: T, userId: ADMIN }, { memberId: cashierMember, roleKey: "cashier", branchIds: [], status: "ACTIVE" }))
      .rejects.toMatchObject({ code: "LAST_ADMIN" });
  });

  it("rechaza roles y usuarios de otro negocio", async () => {
    await expect(updateMember(asAdmin, { memberId: cashierMember, roleKey: "no-existe", branchIds: [], status: "ACTIVE" })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(updateMember({ tenantId: randomUUID(), userId: ADMIN }, { memberId: cashierMember, roleKey: "admin", branchIds: [], status: "ACTIVE" }))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
