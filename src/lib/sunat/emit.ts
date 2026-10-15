import "server-only";
import type { DocumentStatus } from "@/generated/prisma/enums";
import { platformDb } from "@/lib/db";
import { env } from "@/lib/env";
import { D } from "@/lib/money";
import { DomainError } from "@/lib/result";
import { getObject, putObject, tenantPath } from "@/lib/storage";
import { loadSigningMaterial } from "@/lib/platform/tenant-secrets";
import { DOC_TYPE_CODE, isFree, taxGroup, type IgvAffectation } from "@/lib/sunat/catalogs";
import { classifySunatCode, nextRetryDelayMs, type SunatOutcome } from "@/lib/sunat/errors";
import { signUbl } from "@/lib/sunat/signer";
import { SunatSoapClient, SunatTransportError, parseCdrZip, type SoapCallResult } from "@/lib/sunat/soap-client";
import type { DocumentTotals, LineTotals } from "@/lib/sunat/totals";
import { buildUbl, sunatFileName, type UblDocumentInput } from "@/lib/sunat/ubl";

export type HandlerResult =
  | { status: "done" }
  | { status: "retry"; delayMs: number; error: string }
  | { status: "dead"; error: string };

const FINAL: readonly DocumentStatus[] = ["ACEPTADO", "ACEPTADO_CON_OBS", "RECHAZADO", "ANULADO"];
/** Credenciales públicas del ambiente beta de SUNAT */
const BETA_SOL = { user: "MODDATOS", password: "moddatos" };

const isoDate = (d: Date): string => d.toISOString().slice(0, 10);

type LoadedDocument = NonNullable<Awaited<ReturnType<typeof loadDocument>>>;

async function loadDocument(documentId: string) {
  return platformDb().document.findUnique({
    where: { id: documentId },
    include: { items: { orderBy: { line_no: "asc" } } },
  });
}

/** Reconstruye el modelo UBL desde lo PERSISTIDO (nunca recalcula importes). */
async function toUblInput(doc: LoadedDocument): Promise<{ input: UblDocumentInput; ruc: string }> {
  const db = platformDb();
  const [tenant, branch, ref, products] = await Promise.all([
    db.tenant.findUniqueOrThrow({ where: { id: doc.tenant_id } }),
    db.branch.findUniqueOrThrow({ where: { id: doc.branch_id } }),
    doc.ref_document_id ? db.document.findUnique({ where: { id: doc.ref_document_id } }) : Promise.resolve(null),
    db.product.findMany({
      where: { id: { in: doc.items.map((i) => i.product_id).filter((x): x is string => !!x) } },
      select: { id: true, sku: true },
    }),
  ]);
  const skuById = new Map(products.map((p) => [p.id, p.sku]));

  const lines = doc.items.map((it) => {
    const aff = it.igv_affectation as IgvAffectation;
    const free = isFree(aff);
    const factor = taxGroup(aff) === "GRAVADO" ? D("1.18") : D(1);
    const totals: LineTotals = {
      quantity: it.quantity,
      unitPrice: it.unit_price,
      unitValue: it.unit_value,
      referenceValue: free ? it.unit_price.div(factor).toDecimalPlaces(10) : D(0),
      discount: it.discount,
      lineExtension: it.line_extension,
      igvBase: it.igv_base,
      igv: it.igv_amount,
      icbper: it.icbper_amount,
      lineTotal: it.line_total,
      free,
      affectation: aff,
    };
    return {
      totals,
      description: it.description,
      unitCode: it.unit_code,
      sku: it.product_id ? (skuById.get(it.product_id) ?? null) : null,
      icbperUnits: it.icbper_units,
    };
  });

  const igvGratuitas = lines.filter((l) => l.totals.free).reduce((a, l) => a.plus(l.totals.igv), D(0));
  const lineExtension = doc.op_gravadas.plus(doc.op_exoneradas).plus(doc.op_inafectas);
  const totals: DocumentTotals = {
    opGravadas: doc.op_gravadas,
    opExoneradas: doc.op_exoneradas,
    opInafectas: doc.op_inafectas,
    opExportacion: D(0),
    opGratuitas: doc.op_gratuitas,
    igvGratuitas,
    totalDiscount: doc.total_discount,
    igv: doc.igv,
    icbper: doc.icbper,
    lineExtension,
    taxInclusive: lineExtension.plus(doc.igv).plus(doc.icbper),
    total: doc.total,
  };

  return {
    ruc: tenant.ruc,
    input: {
      docType: doc.doc_type,
      series: doc.series,
      number: doc.number,
      issueDate: isoDate(doc.issue_date),
      issueTime: doc.issue_time,
      dueDate: doc.due_date ? isoDate(doc.due_date) : null,
      currency: doc.currency,
      operationType: doc.operation_type,
      paymentTerms: doc.payment_terms === "Credito" ? "Credito" : "Contado",
      issuer: {
        ruc: tenant.ruc,
        legalName: tenant.legal_name,
        tradeName: tenant.trade_name,
        address: branch.address,
        ubigeo: branch.ubigeo,
        department: tenant.department,
        province: tenant.province,
        district: tenant.district,
        urbanization: tenant.urbanization,
        establishmentCode: branch.sunat_code,
      },
      customer: {
        docType: doc.customer_doc_type,
        docNumber: doc.customer_doc_number,
        name: doc.customer_name,
        address: doc.customer_address,
      },
      lines,
      totals,
      reference: ref
        ? {
            docType: ref.doc_type,
            series: ref.series,
            number: ref.number,
            reasonCode: doc.note_reason_code ?? "01",
            reasonText: doc.note_reason_text ?? "Anulación de la operación",
          }
        : null,
    },
  };
}

function endpointFor(tenant: { sunat_env: "BETA" | "PRODUCTION"; ose_endpoint: string | null }): string {
  if (tenant.sunat_env === "BETA") return env().SUNAT_BETA_URL;
  return tenant.ose_endpoint ?? env().SUNAT_PROD_URL;
}

async function outcomeFromCall(res: SoapCallResult): Promise<{ outcome: SunatOutcome; cdrXml: string | null }> {
  if (res.fault) return { outcome: classifySunatCode(res.fault.code, res.fault.message), cdrXml: null };
  if (!res.applicationResponse) {
    return { outcome: { kind: "RETRYABLE", code: "0100", description: "Respuesta sin CDR" }, cdrXml: null };
  }
  const cdr = await parseCdrZip(res.applicationResponse);
  return { outcome: classifySunatCode(cdr.responseCode, cdr.description, cdr.notes), cdrXml: cdr.cdrXml };
}

/**
 * Emite un comprobante: firma (una sola vez), envía, interpreta el CDR y
 * persiste el resultado. Idempotente: puede ejecutarse N veces para el mismo documento.
 */
export async function emitDocument(documentId: string, attempt: number): Promise<HandlerResult> {
  const db = platformDb();
  const doc = await loadDocument(documentId);
  if (!doc) return { status: "dead", error: `Documento ${documentId} inexistente` };
  if (FINAL.includes(doc.status)) return { status: "done" };

  const tenant = await db.tenant.findUniqueOrThrow({ where: { id: doc.tenant_id } });
  if (tenant.status === "SUSPENDED" || tenant.status === "DELETED") {
    return { status: "retry", delayMs: 3_600_000, error: "Tenant suspendido: envío en pausa" };
  }

  let material;
  try {
    material = await loadSigningMaterial(doc.tenant_id);
  } catch (err) {
    if (err instanceof DomainError) {
      await db.document.update({ where: { id: doc.id }, data: { status: "ERROR_REINTENTABLE", sunat_description: err.message } });
      return { status: "retry", delayMs: 3_600_000, error: err.message };
    }
    throw err;
  }

  const fileName = sunatFileName(tenant.ruc, doc.doc_type, doc.series, doc.number);
  const year = String(doc.issue_date.getUTCFullYear());

  // 1) Firmar solo una vez: el hash debe ser estable entre reintentos
  let signedXml: string;
  if (doc.xml_path) {
    signedXml = (await getObject("sunat", doc.xml_path)).toString("utf8");
  } else {
    const { input } = await toUblInput(doc);
    const signed = signUbl(buildUbl(input), material.cert.privateKeyPem, material.cert.certificatePem);
    const xmlPath = tenantPath(doc.tenant_id, "xml", year, `${fileName}.xml`);
    await putObject("sunat", xmlPath, signed.signedXml, "application/xml");
    await db.document.update({
      where: { id: doc.id },
      data: { xml_path: xmlPath, hash: signed.digestValue, status: "ENVIANDO" },
    });
    signedXml = signed.signedXml;
  }

  // 2) Enviar
  const endpoint = endpointFor(tenant);
  const sol = tenant.sunat_env === "BETA" ? BETA_SOL : material.sol;
  const client = new SunatSoapClient(endpoint, { ruc: tenant.ruc, ...sol });

  let res: SoapCallResult;
  try {
    res = await client.sendBill(fileName, signedXml);
  } catch (err) {
    if (err instanceof SunatTransportError) {
      await recordSubmission(doc, attempt, "sendBill", endpoint, { httpStatus: 0, durationMs: 0, fault: { code: "NET", message: err.message } });
      await db.document.update({ where: { id: doc.id }, data: { status: "ERROR_REINTENTABLE", sunat_description: err.message } });
      return { status: "retry", delayMs: nextRetryDelayMs(attempt), error: err.message };
    }
    throw err;
  }
  await recordSubmission(doc, attempt, "sendBill", endpoint, res);
  let { outcome, cdrXml } = await outcomeFromCall(res);

  // 3) Ya registrado: recuperar CDR en lugar de reenviar
  if (outcome.kind === "ALREADY_REGISTERED" && tenant.sunat_env === "PRODUCTION") {
    const statusRes = await client.getStatusCdr(DOC_TYPE_CODE[doc.doc_type], doc.series, doc.number);
    await recordSubmission(doc, attempt, "getStatusCdr", "billConsultService", statusRes);
    ({ outcome, cdrXml } = await outcomeFromCall(statusRes));
  }

  // 4) Persistir resultado
  let cdrPath: string | null = null;
  if (cdrXml) {
    cdrPath = tenantPath(doc.tenant_id, "cdr", year, `R-${fileName}.xml`);
    await putObject("sunat", cdrPath, cdrXml, "application/xml");
  }

  switch (outcome.kind) {
    case "ACCEPTED":
    case "ACCEPTED_WITH_OBS":
      await db.document.update({
        where: { id: doc.id },
        data: {
          status: outcome.kind === "ACCEPTED" ? "ACEPTADO" : "ACEPTADO_CON_OBS",
          sunat_code: outcome.code, sunat_description: outcome.description, sunat_notes: outcome.notes,
          cdr_path: cdrPath, sent_at: new Date(), accepted_at: new Date(),
        },
      });
      return { status: "done" };
    case "REJECTED":
    case "EXCEPTION":
      await db.document.update({
        where: { id: doc.id },
        data: { status: "RECHAZADO", sunat_code: outcome.code, sunat_description: outcome.description, cdr_path: cdrPath, sent_at: new Date() },
      });
      await notifyRejection(doc.tenant_id, doc.id, `${doc.series}-${doc.number}`, outcome.code, outcome.description);
      return { status: "done" };
    case "CONFIG_ERROR":
      await db.document.update({
        where: { id: doc.id },
        data: { status: "ERROR_REINTENTABLE", sunat_code: outcome.code, sunat_description: outcome.description },
      });
      await notifyRejection(doc.tenant_id, doc.id, `${doc.series}-${doc.number}`, outcome.code, `Configuración SUNAT: ${outcome.description}`);
      return { status: "retry", delayMs: 3_600_000, error: outcome.description };
    case "ALREADY_REGISTERED":
      return { status: "dead", error: `Registrado previamente (${outcome.code}); conciliar manualmente en beta` };
    case "RETRYABLE":
      await db.document.update({
        where: { id: doc.id },
        data: { status: "ERROR_REINTENTABLE", sunat_code: outcome.code, sunat_description: outcome.description },
      });
      return { status: "retry", delayMs: nextRetryDelayMs(attempt), error: `${outcome.code} ${outcome.description}` };
  }
}

async function recordSubmission(
  doc: { id: string; tenant_id: string },
  attempt: number,
  operation: string,
  endpoint: string,
  res: SoapCallResult,
): Promise<void> {
  await platformDb().sunatSubmission.create({
    data: {
      tenant_id: doc.tenant_id,
      document_id: doc.id,
      attempt,
      operation,
      endpoint,
      ticket: res.ticket ?? null,
      http_status: res.httpStatus,
      response_code: res.fault?.code ?? res.statusCode ?? null,
      response_text: res.fault?.message?.slice(0, 2000) ?? null,
      fault_code: res.fault?.code ?? null,
      duration_ms: res.durationMs,
    },
  });
}

async function notifyRejection(tenantId: string, documentId: string, label: string, code: string, description: string): Promise<void> {
  const db = platformDb();
  const admins = await db.tenantUser.findMany({
    where: { tenant_id: tenantId, status: "ACTIVE", deleted_at: null, role: { key: { in: ["admin", "accountant"] } } },
    select: { user_id: true },
  });
  await db.notification.createMany({
    data: admins.map((a) => ({
      tenant_id: tenantId,
      user_id: a.user_id,
      channel: "IN_APP" as const,
      template: "sunat_rejection",
      payload: { documentId, label, code, description },
      dedupe_key: `sunat:${documentId}:${code}:${a.user_id}`,
      related_type: "document",
      related_id: documentId,
    })),
    skipDuplicates: true,
  });
}
