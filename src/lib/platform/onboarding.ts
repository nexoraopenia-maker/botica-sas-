import "server-only";
import { z } from "zod";
import { env } from "@/lib/env";
import { platformDb } from "@/lib/db";
import { DomainError } from "@/lib/result";
import { isValidRuc } from "@/lib/sunat/validation";
import { loadSigningMaterial } from "@/lib/platform/tenant-secrets";
import { computeLine, computeTotals } from "@/lib/sunat/totals";
import { buildUbl, sunatFileName } from "@/lib/sunat/ubl";
import { signUbl } from "@/lib/sunat/signer";
import { SunatSoapClient, parseCdrZip } from "@/lib/sunat/soap-client";
import { classifySunatCode, type SunatOutcome } from "@/lib/sunat/errors";
import { limaNow } from "@/lib/time";

const rucLookupSchema = z.object({
  razonSocial: z.string(),
  direccion: z.string().optional().default(""),
  ubigeo: z.string().optional().default(""),
  departamento: z.string().optional().default(""),
  provincia: z.string().optional().default(""),
  distrito: z.string().optional().default(""),
  estado: z.string(),
  condicion: z.string(),
});
export type RucInfo = z.infer<typeof rucLookupSchema> & { ruc: string; warnings: string[] };

/**
 * Validación de RUC: dígito verificador + consulta al padrón (proveedor configurable).
 * Bloquea RUC no ACTIVO; advierte si no está HABIDO.
 */
export async function validateRuc(ruc: string): Promise<RucInfo | { ruc: string; checksumOnly: true }> {
  if (!isValidRuc(ruc)) throw new DomainError("RUC_INVALID", "RUC inválido (dígito verificador).");
  const { RUC_LOOKUP_URL: url, RUC_LOOKUP_TOKEN: token } = env();
  if (!url) return { ruc, checksumOnly: true };
  const res = await fetch(`${url.replace(/\/$/, "")}/${ruc}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new DomainError("RUC_LOOKUP_FAILED", "No se pudo consultar el padrón RUC. Intente nuevamente.");
  const info = rucLookupSchema.parse(await res.json());
  if (info.estado.toUpperCase() !== "ACTIVO") throw new DomainError("RUC_NOT_ACTIVE", `El RUC está en estado ${info.estado}.`);
  const warnings = info.condicion.toUpperCase() === "HABIDO" ? [] : [`Condición de domicilio: ${info.condicion}`];
  return { ...info, ruc, warnings };
}

/**
 * Prueba en ambiente beta: firma con el certificado real del cliente una boleta
 * de prueba y la envía a e-beta.sunat.gob.pe (credenciales MODDATOS). No se
 * persiste como comprobante. Si se acepta, habilita el paso a producción.
 */
export async function runSunatBetaTest(tenantId: string): Promise<SunatOutcome> {
  const db = platformDb();
  const tenant = await db.tenant.findUniqueOrThrow({ where: { id: tenantId } });
  const branch = await db.branch.findFirstOrThrow({ where: { tenant_id: tenantId, sunat_code: "0000" } });
  const material = await loadSigningMaterial(tenantId);
  const now = limaNow();
  const number = Math.floor(Date.now() / 1000) % 99_999_999 || 1;

  const line = computeLine({ quantity: 1, unitPrice: "11.80", affectation: "10" });
  const xml = buildUbl({
    docType: "BOLETA", series: "B999", number, issueDate: now.date, issueTime: now.time, currency: "PEN",
    operationType: "0101", paymentTerms: "Contado",
    issuer: {
      ruc: tenant.ruc, legalName: tenant.legal_name, tradeName: tenant.trade_name, address: branch.address,
      ubigeo: branch.ubigeo, department: tenant.department, province: tenant.province, district: tenant.district,
      urbanization: tenant.urbanization, establishmentCode: branch.sunat_code,
    },
    customer: { docType: "DNI", docNumber: "12345678", name: "CLIENTE DE PRUEBA" },
    lines: [{ totals: line, description: "PRODUCTO DE PRUEBA", unitCode: "NIU", sku: "TEST" }],
    totals: computeTotals([line]),
  });
  const signed = signUbl(xml, material.cert.privateKeyPem, material.cert.certificatePem);
  const client = new SunatSoapClient(env().SUNAT_BETA_URL, { ruc: tenant.ruc, user: "MODDATOS", password: "moddatos" });
  const res = await client.sendBill(sunatFileName(tenant.ruc, "BOLETA", "B999", number), signed.signedXml);

  let outcome: SunatOutcome;
  if (res.fault) outcome = classifySunatCode(res.fault.code, res.fault.message);
  else if (res.applicationResponse) {
    const cdr = await parseCdrZip(res.applicationResponse);
    outcome = classifySunatCode(cdr.responseCode, cdr.description, cdr.notes);
  } else outcome = { kind: "RETRYABLE", code: "0100", description: "Sin respuesta" };

  if (outcome.kind === "ACCEPTED" || outcome.kind === "ACCEPTED_WITH_OBS") {
    await db.tenant.update({ where: { id: tenantId }, data: { sunat_beta_passed_at: new Date(), onboarding_step: 4 } });
  }
  return outcome;
}
