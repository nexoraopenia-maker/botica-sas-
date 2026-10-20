import "server-only";
import { z } from "zod";
import type { Tx } from "@/lib/db";
import { platformDb } from "@/lib/db";
import { open, seal, secretAad } from "@/lib/crypto/envelope";
import { loadPfx, type LoadedCertificate } from "@/lib/sunat/certificate";
import { DomainError } from "@/lib/result";

/** "MODDATOS" → "MO••••OS": identifica cuál se configuró sin exponerlo. */
export const maskSolUser = (u: string): string => (u.length <= 4 ? "••••" : `${u.slice(0, 2)}${"•".repeat(Math.max(u.length - 4, 2))}${u.slice(-2)}`);

/** Prisma Bytes exige Uint8Array<ArrayBuffer> (copia defensiva). */
const bytes = (b: Buffer): Uint8Array<ArrayBuffer> => new Uint8Array(b);

const solSchema = z.object({ user: z.string().min(3).max(20), password: z.string().min(1).max(100) });
const pfxSchema = z.object({ pfxBase64: z.string().min(1), password: z.string() });

export interface CertificateCheck {
  subject: string;
  notAfter: Date;
  notBefore: Date;
  fingerprint: string;
  warnings: string[];
}

/** Valida el .pfx antes de guardarlo: contraseña, vigencia y RUC del titular. */
export function inspectCertificate(pfx: Buffer, password: string, tenantRuc: string): { cert: LoadedCertificate; check: CertificateCheck } {
  let cert: LoadedCertificate;
  try {
    cert = loadPfx(pfx, password);
  } catch {
    throw new DomainError("CERT_INVALID", "No se pudo abrir el certificado: archivo dañado o contraseña incorrecta.");
  }
  const now = new Date();
  if (cert.notAfter <= now) throw new DomainError("CERT_EXPIRED", "El certificado está vencido.");
  if (cert.notBefore > now) throw new DomainError("CERT_NOT_YET_VALID", "El certificado aún no es válido.");
  const warnings: string[] = [];
  if (cert.rucInSubject && cert.rucInSubject !== tenantRuc) {
    throw new DomainError("CERT_RUC_MISMATCH", `El certificado pertenece al RUC ${cert.rucInSubject}, no a ${tenantRuc}.`);
  }
  if (!cert.rucInSubject) warnings.push("El certificado no incluye el RUC en el titular; verifique que sea del emisor.");
  const days = Math.floor((cert.notAfter.getTime() - now.getTime()) / 86_400_000);
  if (days < 30) warnings.push(`El certificado vence en ${days} días.`);
  return {
    cert,
    check: { subject: cert.subject, notAfter: cert.notAfter, notBefore: cert.notBefore, fingerprint: cert.fingerprint, warnings },
  };
}

/** Guarda Clave SOL cifrada (rota la versión anterior). Debe ejecutarse con el cliente de plataforma. */
export async function storeSolCredentials(tx: Tx, tenantId: string, input: { user: string; password: string }, actor: string): Promise<void> {
  const data = solSchema.parse(input);
  const sealed = await seal(Buffer.from(JSON.stringify(data), "utf8"), secretAad(tenantId, "SOL_CREDENTIALS"));
  await tx.tenantSecret.updateMany({
    where: { tenant_id: tenantId, kind: "SOL_CREDENTIALS", is_active: true },
    data: { is_active: false, rotated_at: new Date() },
  });
  await tx.tenantSecret.create({
    data: {
      tenant_id: tenantId, kind: "SOL_CREDENTIALS", ciphertext: bytes(sealed.ciphertext), iv: bytes(sealed.iv),
      auth_tag: bytes(sealed.authTag), wrapped_dek: bytes(sealed.wrappedDek), kek_id: sealed.kekId, created_by: actor,
    },
  });
  // El usuario SOL también viaja solo cifrado; en la ficha del tenant queda una máscara para mostrar
  await tx.tenant.update({ where: { id: tenantId }, data: { sol_user: maskSolUser(data.user) } });
}

export async function storeCertificate(
  tx: Tx, tenantId: string, tenantRuc: string, pfx: Buffer, password: string, actor: string,
): Promise<CertificateCheck> {
  const { cert, check } = inspectCertificate(pfx, password, tenantRuc);
  const payload = Buffer.from(JSON.stringify({ pfxBase64: pfx.toString("base64"), password }), "utf8");
  const sealed = await seal(payload, secretAad(tenantId, "CERTIFICATE_PFX"));
  payload.fill(0);
  await tx.tenantSecret.updateMany({
    where: { tenant_id: tenantId, kind: "CERTIFICATE_PFX", is_active: true },
    data: { is_active: false, rotated_at: new Date() },
  });
  await tx.tenantSecret.create({
    data: {
      tenant_id: tenantId, kind: "CERTIFICATE_PFX", ciphertext: bytes(sealed.ciphertext), iv: bytes(sealed.iv),
      auth_tag: bytes(sealed.authTag), wrapped_dek: bytes(sealed.wrappedDek), kek_id: sealed.kekId,
      cert_subject: cert.subject, cert_serial: cert.serialNumber, cert_not_before: cert.notBefore,
      cert_not_after: cert.notAfter, fingerprint: cert.fingerprint, created_by: actor,
    },
  });
  await tx.tenant.update({ where: { id: tenantId }, data: { certificate_expires_at: cert.notAfter } });
  return check;
}

export interface SigningMaterial {
  cert: LoadedCertificate;
  sol: { user: string; password: string };
  certSecretId: string;
}

const cache = new Map<string, { value: SigningMaterial; expires: number }>();
const CACHE_TTL_MS = 10 * 60_000;

/** Descifra certificado + Clave SOL (solo workers). Cache en memoria 10 min por versión de secreto. */
export async function loadSigningMaterial(tenantId: string): Promise<SigningMaterial> {
  const secrets = await platformDb().tenantSecret.findMany({
    where: { tenant_id: tenantId, is_active: true, kind: { in: ["CERTIFICATE_PFX", "SOL_CREDENTIALS"] } },
  });
  const certRow = secrets.find((s) => s.kind === "CERTIFICATE_PFX");
  const solRow = secrets.find((s) => s.kind === "SOL_CREDENTIALS");
  if (!certRow || !solRow) {
    throw new DomainError("SUNAT_NOT_CONFIGURED", "El negocio no tiene certificado digital o Clave SOL configurados.");
  }
  const key = `${certRow.id}:${solRow.id}`;
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;

  const unseal = async (row: typeof certRow) =>
    JSON.parse(
      (
        await open(
          { ciphertext: Buffer.from(row.ciphertext), iv: Buffer.from(row.iv), authTag: Buffer.from(row.auth_tag), wrappedDek: Buffer.from(row.wrapped_dek), kekId: row.kek_id },
          secretAad(tenantId, row.kind),
        )
      ).toString("utf8"),
    ) as unknown;

  const pfx = pfxSchema.parse(await unseal(certRow));
  const sol = solSchema.parse(await unseal(solRow));
  const value: SigningMaterial = {
    cert: loadPfx(Buffer.from(pfx.pfxBase64, "base64"), pfx.password),
    sol,
    certSecretId: certRow.id,
  };
  cache.set(key, { value, expires: Date.now() + CACHE_TTL_MS });
  return value;
}
