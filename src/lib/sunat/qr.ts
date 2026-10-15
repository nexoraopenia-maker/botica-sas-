import { DOC_TYPE_CODE, IDENTITY_CODE } from "@/lib/sunat/catalogs";
import type { DocumentType, IdentityDocType } from "@/generated/prisma/enums";
import { fmt2, type Decimal } from "@/lib/money";

/** Contenido del QR de la representación impresa (RS 097-2012/SUNAT y modif.). */
export function qrPayload(d: {
  ruc: string; docType: DocumentType; series: string; number: number; igv: Decimal; total: Decimal;
  issueDate: string; customerDocType: IdentityDocType; customerDocNumber: string; hash?: string | null;
}): string {
  return [
    d.ruc, DOC_TYPE_CODE[d.docType], d.series, d.number, fmt2(d.igv), fmt2(d.total), d.issueDate,
    IDENTITY_CODE[d.customerDocType], d.customerDocType === "NO_DOC" ? "-" : d.customerDocNumber, d.hash ?? "",
  ].join("|") + "|";
}
