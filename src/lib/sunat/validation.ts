import type { DocumentType, IdentityDocType } from "@/generated/prisma/enums";
import { D, type Decimal } from "@/lib/money";
import type { CreditNoteReason, DebitNoteReason } from "@/lib/sunat/catalogs";

/** Tope de boleta sin identificación del adquirente (S/). Por encima, DNI/CE/RUC obligatorio. */
export const BOLETA_ANONYMOUS_LIMIT = D(700);
/** Plazo máximo (días calendario) para enviar el comprobante a SUNAT/OSE. */
export const MAX_SEND_DELAY_DAYS = 3;

export interface ValidationIssue {
  code: string;
  message: string;
  field?: string;
}

/** Dígito verificador de RUC (módulo 11). */
export function isValidRuc(ruc: string): boolean {
  if (!/^(10|15|16|17|20)\d{9}$/.test(ruc)) return false;
  const weights = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const s = weights.reduce((acc, w, i) => acc + w * Number(ruc[i]), 0);
  const check = (11 - (s % 11)) % 10;
  return check === Number(ruc[10]);
}

export function isValidDni(dni: string): boolean {
  return /^\d{8}$/.test(dni);
}

export function validateCustomerId(docType: IdentityDocType, number: string): ValidationIssue | null {
  switch (docType) {
    case "RUC":
      return isValidRuc(number) ? null : { code: "RUC_INVALID", message: "RUC inválido", field: "customer.docNumber" };
    case "DNI":
      return isValidDni(number) ? null : { code: "DNI_INVALID", message: "DNI debe tener 8 dígitos", field: "customer.docNumber" };
    case "CE":
    case "PASSPORT":
      return /^[A-Za-z0-9]{6,12}$/.test(number)
        ? null
        : { code: "DOC_INVALID", message: "Documento inválido (6 a 12 caracteres alfanuméricos)", field: "customer.docNumber" };
    case "NO_DOC":
      return null;
  }
}

export interface DocumentRulesInput {
  docType: DocumentType;
  series: string;
  issueDate: Date;
  today: Date;
  total: Decimal;
  customerDocType: IdentityDocType;
  customerDocNumber: string;
  customerName: string;
  paymentTerms: "Contado" | "Credito";
  dueDate?: Date | null;
  reference?: {
    docType: DocumentType;
    series: string;
    status: string;
    reasonCode: CreditNoteReason | DebitNoteReason;
    total: Decimal;
  } | null;
}

/** Reglas de negocio SUNAT previas a la emisión. Devuelve todas las incidencias. */
export function validateDocumentRules(i: DocumentRulesInput): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const push = (code: string, message: string, field?: string) => issues.push({ code, message, ...(field ? { field } : {}) });

  // Series
  const seriesOk =
    (i.docType === "FACTURA" && /^F[A-Z0-9]{3}$/.test(i.series)) ||
    (i.docType === "BOLETA" && /^B[A-Z0-9]{3}$/.test(i.series)) ||
    ((i.docType === "NOTA_CREDITO" || i.docType === "NOTA_DEBITO") && /^[FB][A-Z0-9]{3}$/.test(i.series));
  if (!seriesOk) push("SERIES_FORMAT", `Serie ${i.series} no corresponde al tipo de comprobante`, "series");

  // Fechas
  const day = 86_400_000;
  const diffDays = Math.floor((i.today.getTime() - i.issueDate.getTime()) / day);
  if (diffDays < 0) push("FUTURE_DATE", "La fecha de emisión no puede ser futura", "issueDate");
  if (diffDays > MAX_SEND_DELAY_DAYS) {
    push("LATE_ISSUE", `Fuera del plazo de envío (${MAX_SEND_DELAY_DAYS} días calendario)`, "issueDate");
  }

  // Adquirente
  const idIssue = validateCustomerId(i.customerDocType, i.customerDocNumber);
  if (idIssue) issues.push(idIssue);

  const isInvoiceFamily =
    i.docType === "FACTURA" || ((i.docType === "NOTA_CREDITO" || i.docType === "NOTA_DEBITO") && i.series.startsWith("F"));

  if (isInvoiceFamily && i.customerDocType !== "RUC") {
    push("FACTURA_REQUIRES_RUC", "La factura requiere RUC del adquirente", "customer.docType");
  }
  if (i.docType === "BOLETA" && i.total.greaterThan(BOLETA_ANONYMOUS_LIMIT) && i.customerDocType === "NO_DOC") {
    push(
      "BOLETA_OVER_700_REQUIRES_ID",
      "Boletas mayores a S/ 700.00 requieren DNI, CE, pasaporte o RUC del adquirente",
      "customer.docNumber",
    );
  }
  if (i.customerDocType !== "NO_DOC" && i.customerName.trim().length < 3) {
    push("CUSTOMER_NAME", "Nombre o razón social del adquirente requerido", "customer.name");
  }

  if (i.paymentTerms === "Credito") {
    if (i.docType !== "FACTURA") push("CREDIT_ONLY_FACTURA", "La venta al crédito se emite con factura", "paymentTerms");
    if (!i.dueDate || i.dueDate <= i.issueDate) push("CREDIT_DUE_DATE", "Indique la fecha de vencimiento de la cuota", "dueDate");
  }

  // Notas
  if (i.docType === "NOTA_CREDITO" || i.docType === "NOTA_DEBITO") {
    if (!i.reference) {
      push("NOTE_REFERENCE", "La nota requiere el comprobante de referencia", "reference");
    } else {
      if (i.reference.series[0] !== i.series[0]) {
        push("NOTE_SERIES_PREFIX", "La serie de la nota debe iniciar con la misma letra que el comprobante afectado", "series");
      }
      if (!["ACEPTADO", "ACEPTADO_CON_OBS"].includes(i.reference.status)) {
        push("NOTE_REFERENCE_STATUS", "Solo se emiten notas sobre comprobantes aceptados por SUNAT", "reference");
      }
      if (i.docType === "NOTA_CREDITO" && i.total.greaterThan(i.reference.total)) {
        push("NOTE_EXCEEDS_REFERENCE", "La nota de crédito no puede superar el total del comprobante afectado", "total");
      }
    }
  }

  if (i.total.isNegative()) push("NEGATIVE_TOTAL", "Total inválido", "total");
  return issues;
}
