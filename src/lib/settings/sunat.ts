import "server-only";
import { z } from "zod";
import { platformDb, type TenantDbContext } from "@/lib/db";
import { audit } from "@/lib/audit";
import { DomainError } from "@/lib/result";
import { normalizeCertificateFile } from "@/lib/sunat/certificate";
import { storeCertificate, storeSolCredentials, type CertificateCheck } from "@/lib/platform/tenant-secrets";
import { runSunatBetaTest } from "@/lib/platform/onboarding";
import type { SunatOutcome } from "@/lib/sunat/errors";

/*
 * Facturación SUNAT del negocio (autoservicio del administrador).
 * tenant_secrets no es accesible para el rol de runtime (RLS sin políticas + REVOKE): estas
 * operaciones usan el cliente de plataforma, SIEMPRE con el tenant_id de la sesión ya verificada
 * por requireTenant(settings.manage). Los secretos se cifran con envelope encryption (DEK por
 * secreto envuelta con la KEK SECRETS_KEK_BASE64, AAD = tenant) y nunca se devuelven al navegador.
 */

export interface SunatStatus {
  ruc: string;
  legalName: string;
  env: "BETA" | "PRODUCTION";
  betaPassedAt: string | null;
  solUserMask: string | null;
  solUpdatedAt: string | null;
  certificate: { subject: string | null; notAfter: string | null; fingerprint: string | null; uploadedAt: string } | null;
  recent: { at: string; document: string; operation: string; code: string | null; text: string | null }[];
  readyForProduction: { ok: boolean; missing: string[] };
}

export async function getSunatStatus(tenantId: string): Promise<SunatStatus> {
  const db = platformDb();
  const [t, secrets, recent] = await Promise.all([
    db.tenant.findUniqueOrThrow({ where: { id: tenantId } }),
    db.tenantSecret.findMany({
      where: { tenant_id: tenantId, is_active: true },
      select: { kind: true, cert_subject: true, cert_not_after: true, fingerprint: true, created_at: true }, // sin ciphertext
    }),
    db.sunatSubmission.findMany({
      where: { tenant_id: tenantId }, orderBy: { created_at: "desc" }, take: 10,
      include: { document: { select: { series: true, number: true } } },
    }),
  ]);
  const cert = secrets.find((s) => s.kind === "CERTIFICATE_PFX");
  const sol = secrets.find((s) => s.kind === "SOL_CREDENTIALS");
  const missing: string[] = [];
  if (!t.sunat_beta_passed_at) missing.push("aprobar la prueba en beta");
  if (!cert || !cert.cert_not_after || cert.cert_not_after < new Date()) missing.push("un certificado digital vigente");
  if (!sol) missing.push("el usuario y la clave SOL");
  return {
    ruc: t.ruc,
    legalName: t.legal_name,
    env: t.sunat_env,
    betaPassedAt: t.sunat_beta_passed_at?.toISOString() ?? null,
    solUserMask: sol ? t.sol_user : null,
    solUpdatedAt: sol?.created_at.toISOString() ?? null,
    certificate: cert ? {
      subject: cert.cert_subject, notAfter: cert.cert_not_after?.toISOString() ?? null,
      fingerprint: cert.fingerprint, uploadedAt: cert.created_at.toISOString(),
    } : null,
    recent: recent.map((r) => ({
      at: r.created_at.toISOString(), document: `${r.document.series}-${r.document.number}`, operation: r.operation,
      code: r.response_code, text: r.response_text,
    })),
    readyForProduction: { ok: missing.length === 0, missing },
  };
}

export const solSchema = z.object({
  user: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{3,20}$/, "Usuario SOL: 3 a 20 letras o números (sin el RUC)"),
  password: z.string().min(1, "Ingrese la clave SOL").max(100),
});

export async function saveSolCredentials(ctx: TenantDbContext, raw: z.input<typeof solSchema>): Promise<void> {
  const i = solSchema.parse(raw);
  await platformDb().$transaction(async (tx) => {
    await storeSolCredentials(tx, ctx.tenantId, i, ctx.userId);
    await audit(tx, {
      tenantId: ctx.tenantId, actorUserId: ctx.userId, actorKind: "tenant_user", action: "sunat.sol_credentials",
      entityType: "tenant", entityId: ctx.tenantId, after: { sol_user: "[REDACTED]", password: "[REDACTED]" },
    });
  });
}

const MAX_CERT_BYTES = 50_000;

export async function uploadCertificate(ctx: TenantDbContext, file: File, password: string): Promise<CertificateCheck> {
  if (!(file instanceof File) || file.size === 0) throw new DomainError("VALIDATION", "Seleccione el archivo del certificado.");
  if (file.size > MAX_CERT_BYTES) throw new DomainError("VALIDATION", "El archivo es demasiado grande para un certificado (.pfx/.pem).");
  if (!/\.(pfx|p12|pem|crt|key)$/i.test(file.name)) throw new DomainError("VALIDATION", "Formato no soportado: use .pfx, .p12 o .pem.");
  const raw = Buffer.from(await file.arrayBuffer());
  let pfx: Buffer;
  try {
    // Copia: con un .pfx la normalización devuelve el mismo búfer, y `raw` se borra abajo
    pfx = Buffer.from(normalizeCertificateFile(raw, file.name, password));
  } catch (err) {
    throw new DomainError("CERT_INVALID", err instanceof Error ? err.message : "No se pudo leer el certificado.");
  } finally {
    raw.fill(0);
  }
  const db = platformDb();
  const tenant = await db.tenant.findUniqueOrThrow({ where: { id: ctx.tenantId }, select: { ruc: true } });
  try {
    return await db.$transaction(async (tx) => {
      const check = await storeCertificate(tx, ctx.tenantId, tenant.ruc, pfx, password, ctx.userId);
      await audit(tx, {
        tenantId: ctx.tenantId, actorUserId: ctx.userId, actorKind: "tenant_user", action: "sunat.certificate",
        entityType: "tenant", entityId: ctx.tenantId,
        after: { subject: check.subject, notAfter: check.notAfter.toISOString(), fingerprint: check.fingerprint, file: file.name },
      });
      return check;
    });
  } finally {
    pfx.fill(0);
  }
}

export const legalNameSchema = z.object({ legalName: z.string().trim().min(3).max(200) });

/** Razón social (debe coincidir con la de SUNAT: va en cada comprobante). El RUC no se edita. */
export async function updateLegalName(ctx: TenantDbContext, raw: z.input<typeof legalNameSchema>): Promise<void> {
  const { legalName } = legalNameSchema.parse(raw);
  await platformDb().$transaction(async (tx) => {
    const before = await tx.tenant.findUniqueOrThrow({ where: { id: ctx.tenantId }, select: { legal_name: true } });
    await tx.tenant.update({ where: { id: ctx.tenantId }, data: { legal_name: legalName.toUpperCase() } });
    await audit(tx, {
      tenantId: ctx.tenantId, actorUserId: ctx.userId, actorKind: "tenant_user", action: "tenant.legal_name",
      entityType: "tenant", entityId: ctx.tenantId, before: { legal_name: before.legal_name }, after: { legal_name: legalName.toUpperCase() },
    });
  });
}

export const envSchema = z.object({ env: z.enum(["BETA", "PRODUCTION"]) });

export async function setSunatEnv(ctx: TenantDbContext, raw: z.input<typeof envSchema>): Promise<void> {
  const { env } = envSchema.parse(raw);
  if (env === "PRODUCTION") {
    const status = await getSunatStatus(ctx.tenantId);
    if (!status.readyForProduction.ok) {
      throw new DomainError("NOT_READY", `Para pasar a producción falta: ${status.readyForProduction.missing.join(", ")}.`);
    }
  }
  await platformDb().$transaction(async (tx) => {
    const before = await tx.tenant.findUniqueOrThrow({ where: { id: ctx.tenantId }, select: { sunat_env: true } });
    await tx.tenant.update({ where: { id: ctx.tenantId }, data: { sunat_env: env } });
    await audit(tx, {
      tenantId: ctx.tenantId, actorUserId: ctx.userId, actorKind: "tenant_user", action: "sunat.environment",
      entityType: "tenant", entityId: ctx.tenantId, before: { sunat_env: before.sunat_env }, after: { sunat_env: env },
    });
  });
}

/** Firma una boleta de prueba con el certificado del negocio y la envía al ambiente beta de SUNAT. */
export async function testBeta(ctx: TenantDbContext): Promise<SunatOutcome> {
  const outcome = await runSunatBetaTest(ctx.tenantId);
  await platformDb().$transaction((tx) => audit(tx, {
    tenantId: ctx.tenantId, actorUserId: ctx.userId, actorKind: "tenant_user", action: "sunat.beta_test",
    entityType: "tenant", entityId: ctx.tenantId, after: { result: outcome.kind, code: outcome.code },
  }));
  return outcome;
}
