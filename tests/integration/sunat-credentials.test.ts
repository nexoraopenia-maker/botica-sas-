/** Credenciales SUNAT: cifrado en reposo, descifrado en memoria y reglas de entorno (PostgreSQL real). */
import { randomUUID } from "node:crypto";
import forge from "node-forge";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeTestPfx } from "../support/cert";

Object.assign(process.env, {
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgresql://x@localhost/x",
  PLATFORM_DATABASE_URL: process.env.TEST_PLATFORM_DATABASE_URL ?? "postgresql://x@localhost/x",
});

const T = randomUUID();
const RUC = "20131312955";
const ctx = { tenantId: T, userId: randomUUID() };

function makePem(ruc: string, password?: string): string {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "02";
  cert.validity.notBefore = new Date(Date.now() - 864e5);
  cert.validity.notAfter = new Date(Date.now() + 200 * 864e5);
  const attrs = [{ name: "commonName", value: `EMPRESA ${ruc}` }];
  cert.setSubject(attrs); cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const key = password ? forge.pki.encryptRsaPrivateKey(keys.privateKey, password) : forge.pki.privateKeyToPem(keys.privateKey);
  return `${forge.pki.certificateToPem(cert)}\n${key}`;
}

describe("Credenciales SUNAT cifradas (PostgreSQL)", async () => {
  const { platformDb, runtimeDb } = await import("@/lib/db");
  const sunat = await import("@/lib/settings/sunat");
  const { loadSigningMaterial } = await import("@/lib/platform/tenant-secrets");
  const db = platformDb();

  beforeAll(async () => {
    await db.$executeRawUnsafe(`DELETE FROM tenant_secrets WHERE tenant_id IN (SELECT id FROM tenants WHERE ruc = '${RUC}')`);
    await db.$executeRawUnsafe(`DELETE FROM tenants WHERE ruc = '${RUC}' AND slug LIKE 'sun-%'`);
    await db.$executeRawUnsafe(`INSERT INTO tenants (id, slug, ruc, legal_name, business_lines, fiscal_address, ubigeo, department, province, district, contact_email, status)
      VALUES ('${T}', 'sun-${T.slice(0, 8)}', '${RUC}', 'EMPRESA SUNAT TEST', '{RETAIL}', 'Av 1', '150101', 'LIMA', 'LIMA', 'LIMA', 's@t.pe', 'ACTIVE')`);
  });
  afterAll(async () => { await runtimeDb().$disconnect(); await db.$disconnect(); });

  it("guarda usuario y clave SOL cifrados; en la ficha solo queda una máscara", async () => {
    await sunat.saveSolCredentials(ctx, { user: "factura1", password: "ClaveSecreta-123" });
    const row = await db.tenantSecret.findFirstOrThrow({ where: { tenant_id: T, kind: "SOL_CREDENTIALS", is_active: true } });
    const stored = Buffer.concat([Buffer.from(row.ciphertext), Buffer.from(row.wrapped_dek)]).toString("latin1");
    expect(stored).not.toContain("ClaveSecreta-123");
    expect(stored).not.toContain("FACTURA1");
    expect((await db.tenant.findUniqueOrThrow({ where: { id: T } })).sol_user).toBe("FA••••A1");
  });

  it("acepta .pfx, valida RUC y descifra en memoria para firmar", async () => {
    const file = new File([new Uint8Array(makeTestPfx(RUC, "pfx-pass"))], "certificado.pfx");
    const check = await sunat.uploadCertificate(ctx, file, "pfx-pass");
    expect(check.subject).toContain(RUC);
    const m = await loadSigningMaterial(T);
    expect(m.sol).toEqual({ user: "FACTURA1", password: "ClaveSecreta-123" });
    expect(m.cert.privateKeyPem).toContain("PRIVATE KEY");
    expect(m.cert.rucInSubject).toBe(RUC);
  });

  it("acepta .pem (con y sin contraseña) y rechaza certificados de otro RUC", async () => {
    await expect(sunat.uploadCertificate(ctx, new File([makePem(RUC)], "cert.pem"), "")).resolves.toMatchObject({ subject: expect.stringContaining(RUC) });
    await expect(sunat.uploadCertificate(ctx, new File([makePem(RUC, "k3y")], "cert.pem"), "k3y")).resolves.toBeTruthy();
    await expect(sunat.uploadCertificate(ctx, new File([makePem(RUC, "k3y")], "cert.pem"), "mala")).rejects.toMatchObject({ code: "CERT_INVALID" });
    await expect(sunat.uploadCertificate(ctx, new File([new Uint8Array(makeTestPfx("20100070970", "x"))], "otro.pfx"), "x")).rejects.toMatchObject({ code: "CERT_RUC_MISMATCH" });
    const active = await db.tenantSecret.count({ where: { tenant_id: T, kind: "CERTIFICATE_PFX", is_active: true } });
    expect(active).toBe(1); // las versiones anteriores quedan rotadas
  });

  it("no permite producción sin prueba beta aprobada; beta siempre permitido", async () => {
    await expect(sunat.setSunatEnv(ctx, { env: "PRODUCTION" })).rejects.toMatchObject({ code: "NOT_READY" });
    await db.tenant.update({ where: { id: T }, data: { sunat_beta_passed_at: new Date() } });
    await sunat.setSunatEnv(ctx, { env: "PRODUCTION" });
    expect((await db.tenant.findUniqueOrThrow({ where: { id: T } })).sunat_env).toBe("PRODUCTION");
    await sunat.setSunatEnv(ctx, { env: "BETA" });
  });

  it("el estado nunca expone secretos", async () => {
    const s = await sunat.getSunatStatus(T);
    const json = JSON.stringify(s);
    expect(json).not.toContain("ClaveSecreta-123");
    expect(json).not.toContain("FACTURA1");
    expect(s.solUserMask).toBe("FA••••A1");
  });
});
