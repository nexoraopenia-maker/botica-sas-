import type { DocumentType, IdentityDocType } from "@/generated/prisma/enums";
import { fmt2, type Decimal } from "@/lib/money";
import { amountInWords } from "@/lib/sunat/amount-in-words";
import {
  DOC_TYPE_CODE, IDENTITY_CODE, TAX_SCHEMES, lineTaxScheme, taxGroup, type TaxScheme,
} from "@/lib/sunat/catalogs";
import type { DocumentTotals, LineTotals } from "@/lib/sunat/totals";

// ─────────────────────────── Modelo de entrada ───────────────────────────

export interface UblIssuer {
  ruc: string;
  legalName: string;
  tradeName?: string | null;
  address: string;
  ubigeo: string;
  department: string;
  province: string;
  district: string;
  urbanization?: string | null;
  /** Código de establecimiento anexo (0000 = domicilio fiscal) */
  establishmentCode: string;
}

export interface UblCustomer {
  docType: IdentityDocType;
  docNumber: string;
  name: string;
  address?: string | null;
}

export interface UblLine {
  totals: LineTotals;
  description: string;
  unitCode: string;
  sku?: string | null;
  icbperUnits?: number;
}

export interface UblDocumentInput {
  docType: DocumentType;
  series: string;
  number: number;
  issueDate: string; // YYYY-MM-DD
  issueTime: string; // HH:mm:ss
  dueDate?: string | null;
  currency: string;
  operationType: string; // catálogo 51
  paymentTerms: "Contado" | "Credito";
  issuer: UblIssuer;
  customer: UblCustomer;
  lines: UblLine[];
  totals: DocumentTotals;
  reference?: {
    docType: DocumentType;
    series: string;
    number: number;
    reasonCode: string;
    reasonText: string;
  } | null;
}

// ─────────────────────────── Utilidades XML ───────────────────────────

export const escapeXml = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
    // Caracteres de control no permitidos en XML 1.0
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");

type Attrs = Record<string, string | number | undefined>;

function el(name: string, content: string | number | null | undefined, attrs: Attrs = {}): string {
  if (content === null || content === undefined || content === "") return "";
  const a = Object.entries(attrs)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => ` ${k}="${escapeXml(String(v))}"`)
    .join("");
  return `<${name}${a}>${typeof content === "number" ? content : content}</${name}>`;
}

/** Texto escapado */
const t = (s: string | null | undefined): string => (s ? escapeXml(s) : "");
const amt = (currency: string) => (v: Decimal, name: string): string =>
  el(name, fmt2(v), { currencyID: currency });

const NS = {
  Invoice: "urn:oasis:names:specification:ubl:schema:xsd:Invoice-2",
  CreditNote: "urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2",
  DebitNote: "urn:oasis:names:specification:ubl:schema:xsd:DebitNote-2",
  cac: "urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2",
  cbc: "urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2",
  ds: "http://www.w3.org/2000/09/xmldsig#",
  ext: "urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2",
};

const CAT = (n: string) => `urn:pe:gob:sunat:cpe:see:gem:catalogos:catalogo${n}`;

export const SIGNATURE_ID = "SignatureSP";

export function documentId(series: string, number: number): string {
  return `${series}-${number}`;
}

/** Nombre de archivo SUNAT: RUC-TT-SERIE-NUMERO */
export function sunatFileName(ruc: string, docType: DocumentType, series: string, number: number): string {
  return `${ruc}-${DOC_TYPE_CODE[docType]}-${series}-${number}`;
}

// ─────────────────────────── Bloques comunes ───────────────────────────

function partyId(docType: IdentityDocType, num: string): string {
  return `<cac:PartyIdentification>${el("cbc:ID", t(num), {
    schemeID: IDENTITY_CODE[docType],
    schemeName: "Documento de Identidad",
    schemeAgencyName: "PE:SUNAT",
    schemeURI: CAT("06"),
  })}</cac:PartyIdentification>`;
}

function signatureBlock(i: UblIssuer): string {
  return `<cac:Signature>
<cbc:ID>${t(i.ruc)}</cbc:ID>
<cac:SignatoryParty>${`<cac:PartyIdentification><cbc:ID>${t(i.ruc)}</cbc:ID></cac:PartyIdentification>`}<cac:PartyName><cbc:Name>${t(i.legalName)}</cbc:Name></cac:PartyName></cac:SignatoryParty>
<cac:DigitalSignatureAttachment><cac:ExternalReference><cbc:URI>#${SIGNATURE_ID}</cbc:URI></cac:ExternalReference></cac:DigitalSignatureAttachment>
</cac:Signature>`;
}

function supplierBlock(i: UblIssuer): string {
  return `<cac:AccountingSupplierParty><cac:Party>
${partyId("RUC", i.ruc)}
${i.tradeName ? `<cac:PartyName><cbc:Name>${t(i.tradeName)}</cbc:Name></cac:PartyName>` : ""}
<cac:PartyLegalEntity>
<cbc:RegistrationName>${t(i.legalName)}</cbc:RegistrationName>
<cac:RegistrationAddress>
${el("cbc:ID", t(i.ubigeo), { schemeName: "Ubigeos", schemeAgencyName: "PE:INEI" })}
${el("cbc:AddressTypeCode", t(i.establishmentCode), { listAgencyName: "PE:SUNAT", listName: "Establecimientos anexos" })}
${el("cbc:CitySubdivisionName", t(i.urbanization ?? "-"))}
${el("cbc:CityName", t(i.province))}
${el("cbc:CountrySubentity", t(i.department))}
${el("cbc:District", t(i.district))}
<cac:AddressLine><cbc:Line>${t(i.address)}</cbc:Line></cac:AddressLine>
<cac:Country>${el("cbc:IdentificationCode", "PE", {
    listID: "ISO 3166-1",
    listAgencyName: "United Nations Economic Commission for Europe",
    listName: "Country",
  })}</cac:Country>
</cac:RegistrationAddress>
</cac:PartyLegalEntity>
</cac:Party></cac:AccountingSupplierParty>`;
}

function customerBlock(c: UblCustomer): string {
  const docNumber = c.docType === "NO_DOC" ? "-" : c.docNumber;
  const address = c.address
    ? `<cac:RegistrationAddress><cac:AddressLine><cbc:Line>${t(c.address)}</cbc:Line></cac:AddressLine></cac:RegistrationAddress>`
    : "";
  return `<cac:AccountingCustomerParty><cac:Party>
${partyId(c.docType, docNumber)}
<cac:PartyLegalEntity><cbc:RegistrationName>${t(c.name)}</cbc:RegistrationName>${address}</cac:PartyLegalEntity>
</cac:Party></cac:AccountingCustomerParty>`;
}

function taxSchemeXml(s: TaxScheme): string {
  return `<cac:TaxScheme>${el("cbc:ID", s.id, {
    schemeName: "Codigo de tributos",
    schemeAgencyName: "PE:SUNAT",
    schemeURI: CAT("05"),
  })}<cbc:Name>${s.name}</cbc:Name><cbc:TaxTypeCode>${s.typeCode}</cbc:TaxTypeCode></cac:TaxScheme>`;
}

function docTaxTotal(d: UblDocumentInput): string {
  const a = amt(d.currency);
  const T = d.totals;
  const sub = (base: Decimal, tax: Decimal, s: TaxScheme) =>
    `<cac:TaxSubtotal>${a(base, "cbc:TaxableAmount")}${a(tax, "cbc:TaxAmount")}<cac:TaxCategory>${taxSchemeXml(s)}</cac:TaxCategory></cac:TaxSubtotal>`;

  const parts: string[] = [];
  const hasGroup = (g: string, free = false) => d.lines.some((l) => l.totals.free === free && taxGroup(l.totals.affectation) === g);
  if (hasGroup("GRAVADO")) parts.push(sub(T.opGravadas, T.igv, TAX_SCHEMES.IGV));
  if (hasGroup("EXONERADO")) parts.push(sub(T.opExoneradas, T.opExoneradas.times(0), TAX_SCHEMES.EXO));
  if (hasGroup("INAFECTO")) parts.push(sub(T.opInafectas, T.opInafectas.times(0), TAX_SCHEMES.INA));
  if (hasGroup("EXPORTACION")) parts.push(sub(T.opExportacion, T.opExportacion.times(0), TAX_SCHEMES.EXP));
  if (d.lines.some((l) => l.totals.free)) parts.push(sub(T.opGratuitas, T.igvGratuitas, TAX_SCHEMES.GRA));
  if (T.icbper.greaterThan(0)) {
    parts.push(
      `<cac:TaxSubtotal>${a(T.icbper, "cbc:TaxAmount")}<cac:TaxCategory>${taxSchemeXml(TAX_SCHEMES.ICBPER)}</cac:TaxCategory></cac:TaxSubtotal>`,
    );
  }
  return `<cac:TaxTotal>${a(T.igv.plus(T.icbper), "cbc:TaxAmount")}${parts.join("")}</cac:TaxTotal>`;
}

function monetaryTotal(d: UblDocumentInput, tag: "cac:LegalMonetaryTotal" | "cac:RequestedMonetaryTotal"): string {
  const a = amt(d.currency);
  return `<${tag}>${a(d.totals.lineExtension, "cbc:LineExtensionAmount")}${a(d.totals.taxInclusive, "cbc:TaxInclusiveAmount")}${a(d.totals.total, "cbc:PayableAmount")}</${tag}>`;
}

function lineXml(d: UblDocumentInput, l: UblLine, idx: number, tag: "Invoice" | "CreditNote" | "DebitNote"): string {
  const a = amt(d.currency);
  const L = l.totals;
  const qtyTag = tag === "Invoice" ? "cbc:InvoicedQuantity" : tag === "CreditNote" ? "cbc:CreditedQuantity" : "cbc:DebitedQuantity";
  const scheme = lineTaxScheme(L.affectation);
  const percent = taxGroup(L.affectation) === "GRAVADO" ? "18.00" : "0.00";

  const pricing = L.free
    ? `<cac:PricingReference><cac:AlternativeConditionPrice>${el("cbc:PriceAmount", L.referenceValue.toFixed(10), { currencyID: d.currency })}${el("cbc:PriceTypeCode", "02", { listName: "Tipo de Precio", listAgencyName: "PE:SUNAT", listURI: CAT("16") })}</cac:AlternativeConditionPrice></cac:PricingReference>`
    : `<cac:PricingReference><cac:AlternativeConditionPrice>${el("cbc:PriceAmount", L.unitPrice.toFixed(10), { currencyID: d.currency })}${el("cbc:PriceTypeCode", "01", { listName: "Tipo de Precio", listAgencyName: "PE:SUNAT", listURI: CAT("16") })}</cac:AlternativeConditionPrice></cac:PricingReference>`;

  const discount = L.discount.greaterThan(0)
    ? `<cac:AllowanceCharge><cbc:ChargeIndicator>false</cbc:ChargeIndicator>${el("cbc:AllowanceChargeReasonCode", "00", { listAgencyName: "PE:SUNAT", listName: "Cargo/descuento", listURI: CAT("53") })}<cbc:MultiplierFactorNumeric>${L.discount.div(L.lineExtension.plus(L.discount)).toFixed(5)}</cbc:MultiplierFactorNumeric>${a(L.discount, "cbc:Amount")}${a(L.lineExtension.plus(L.discount), "cbc:BaseAmount")}</cac:AllowanceCharge>`
    : "";

  const icbperSub = L.icbper.greaterThan(0)
    ? `<cac:TaxSubtotal>${a(L.icbper, "cbc:TaxAmount")}${el("cbc:BaseUnitMeasure", l.icbperUnits ?? 0, { unitCode: "NIU" })}<cac:TaxCategory>${el("cbc:PerUnitAmount", "0.50", { currencyID: d.currency })}${taxSchemeXml(TAX_SCHEMES.ICBPER)}</cac:TaxCategory></cac:TaxSubtotal>`
    : "";

  return `<cac:${tag}Line>
<cbc:ID>${idx + 1}</cbc:ID>
${el(qtyTag, L.quantity.toString(), { unitCode: t(l.unitCode), unitCodeListID: "UN/ECE rec 20", unitCodeListAgencyName: "United Nations Economic Commission for Europe" })}
${a(L.lineExtension, "cbc:LineExtensionAmount")}
${pricing}
${discount}
<cac:TaxTotal>${a(L.igv.plus(L.icbper), "cbc:TaxAmount")}<cac:TaxSubtotal>${a(L.igvBase, "cbc:TaxableAmount")}${a(L.igv, "cbc:TaxAmount")}<cac:TaxCategory><cbc:Percent>${percent}</cbc:Percent>${el("cbc:TaxExemptionReasonCode", L.affectation, { listAgencyName: "PE:SUNAT", listName: "Afectacion del IGV", listURI: CAT("07") })}${taxSchemeXml(scheme)}</cac:TaxCategory></cac:TaxSubtotal>${icbperSub}</cac:TaxTotal>
<cac:Item><cbc:Description><![CDATA[${l.description.replace(/]]>/g, "]]]]><![CDATA[>")}]]></cbc:Description>${l.sku ? `<cac:SellersItemIdentification><cbc:ID>${t(l.sku)}</cbc:ID></cac:SellersItemIdentification>` : ""}</cac:Item>
<cac:Price>${el("cbc:PriceAmount", L.unitValue.toFixed(10), { currencyID: d.currency })}</cac:Price>
</cac:${tag}Line>`;
}

function notes(d: UblDocumentInput): string {
  const out = [el("cbc:Note", t(amountInWords(d.totals.total, d.currency)), { languageLocaleID: "1000" })];
  if (d.totals.opGratuitas.greaterThan(0)) {
    out.push(el("cbc:Note", "TRANSFERENCIA GRATUITA DE UN BIEN Y/O SERVICIO PRESTADO GRATUITAMENTE", { languageLocaleID: "1002" }));
  }
  return out.join("\n");
}

function paymentTerms(d: UblDocumentInput): string {
  if (d.docType !== "FACTURA") return "";
  if (d.paymentTerms === "Contado") {
    return `<cac:PaymentTerms><cbc:ID>FormaPago</cbc:ID><cbc:PaymentMeansID>Contado</cbc:PaymentMeansID></cac:PaymentTerms>`;
  }
  const a = amt(d.currency);
  return `<cac:PaymentTerms><cbc:ID>FormaPago</cbc:ID><cbc:PaymentMeansID>Credito</cbc:PaymentMeansID>${a(d.totals.total, "cbc:Amount")}</cac:PaymentTerms>
<cac:PaymentTerms><cbc:ID>FormaPago</cbc:ID><cbc:PaymentMeansID>Cuota001</cbc:PaymentMeansID>${a(d.totals.total, "cbc:Amount")}<cbc:PaymentDueDate>${t(d.dueDate ?? "")}</cbc:PaymentDueDate></cac:PaymentTerms>`;
}

const header = (root: string) =>
  `<?xml version="1.0" encoding="UTF-8"?>
<${root} xmlns="${NS[root as "Invoice"]}" xmlns:cac="${NS.cac}" xmlns:cbc="${NS.cbc}" xmlns:ds="${NS.ds}" xmlns:ext="${NS.ext}">
<ext:UBLExtensions><ext:UBLExtension><ext:ExtensionContent/></ext:UBLExtension></ext:UBLExtensions>
<cbc:UBLVersionID>2.1</cbc:UBLVersionID>
${el("cbc:CustomizationID", "2.0", { schemeAgencyName: "PE:SUNAT" })}`;

const currencyCode = (c: string) =>
  el("cbc:DocumentCurrencyCode", c, {
    listID: "ISO 4217 Alpha",
    listName: "Currency",
    listAgencyName: "United Nations Economic Commission for Europe",
  });

// ─────────────────────────── Documentos ───────────────────────────

export function buildInvoiceXml(d: UblDocumentInput): string {
  if (d.docType !== "FACTURA" && d.docType !== "BOLETA") throw new Error("buildInvoiceXml solo para 01/03");
  return `${header("Invoice")}
<cbc:ID>${documentId(d.series, d.number)}</cbc:ID>
<cbc:IssueDate>${d.issueDate}</cbc:IssueDate>
<cbc:IssueTime>${d.issueTime}</cbc:IssueTime>
${el("cbc:DueDate", d.dueDate ?? null)}
${el("cbc:InvoiceTypeCode", DOC_TYPE_CODE[d.docType], {
    listAgencyName: "PE:SUNAT",
    listName: "Tipo de Documento",
    listURI: CAT("01"),
    listID: d.operationType,
    name: "Tipo de Operacion",
  })}
${notes(d)}
${currencyCode(d.currency)}
<cbc:LineCountNumeric>${d.lines.length}</cbc:LineCountNumeric>
${signatureBlock(d.issuer)}
${supplierBlock(d.issuer)}
${customerBlock(d.customer)}
${paymentTerms(d)}
${docTaxTotal(d)}
${monetaryTotal(d, "cac:LegalMonetaryTotal")}
${d.lines.map((l, i) => lineXml(d, l, i, "Invoice")).join("\n")}
</Invoice>`;
}

function referenceBlocks(d: UblDocumentInput, listNo: "09" | "10"): string {
  const r = d.reference;
  if (!r) throw new Error("Nota sin documento de referencia");
  const refId = documentId(r.series, r.number);
  return `<cac:DiscrepancyResponse><cbc:ReferenceID>${refId}</cbc:ReferenceID>${el("cbc:ResponseCode", r.reasonCode, {
    listAgencyName: "PE:SUNAT",
    listName: listNo === "09" ? "Tipo de nota de credito" : "Tipo de nota de debito",
    listURI: CAT(listNo),
  })}<cbc:Description><![CDATA[${r.reasonText}]]></cbc:Description></cac:DiscrepancyResponse>
<cac:BillingReference><cac:InvoiceDocumentReference><cbc:ID>${refId}</cbc:ID>${el("cbc:DocumentTypeCode", DOC_TYPE_CODE[r.docType], {
    listAgencyName: "PE:SUNAT",
    listName: "Tipo de Documento",
    listURI: CAT("01"),
  })}</cac:InvoiceDocumentReference></cac:BillingReference>`;
}

export function buildCreditNoteXml(d: UblDocumentInput): string {
  return `${header("CreditNote")}
<cbc:ID>${documentId(d.series, d.number)}</cbc:ID>
<cbc:IssueDate>${d.issueDate}</cbc:IssueDate>
<cbc:IssueTime>${d.issueTime}</cbc:IssueTime>
${notes(d)}
${currencyCode(d.currency)}
${referenceBlocks(d, "09")}
${signatureBlock(d.issuer)}
${supplierBlock(d.issuer)}
${customerBlock(d.customer)}
${docTaxTotal(d)}
${monetaryTotal(d, "cac:LegalMonetaryTotal")}
${d.lines.map((l, i) => lineXml(d, l, i, "CreditNote")).join("\n")}
</CreditNote>`;
}

export function buildDebitNoteXml(d: UblDocumentInput): string {
  return `${header("DebitNote")}
<cbc:ID>${documentId(d.series, d.number)}</cbc:ID>
<cbc:IssueDate>${d.issueDate}</cbc:IssueDate>
<cbc:IssueTime>${d.issueTime}</cbc:IssueTime>
${notes(d)}
${currencyCode(d.currency)}
${referenceBlocks(d, "10")}
${signatureBlock(d.issuer)}
${supplierBlock(d.issuer)}
${customerBlock(d.customer)}
${docTaxTotal(d)}
${monetaryTotal(d, "cac:RequestedMonetaryTotal")}
${d.lines.map((l, i) => lineXml(d, l, i, "DebitNote")).join("\n")}
</DebitNote>`;
}

export function buildUbl(d: UblDocumentInput): string {
  const raw =
    d.docType === "NOTA_CREDITO" ? buildCreditNoteXml(d) : d.docType === "NOTA_DEBITO" ? buildDebitNoteXml(d) : buildInvoiceXml(d);
  // Quitar líneas vacías generadas por bloques opcionales
  return raw.replace(/\n\s*\n/g, "\n");
}

// ─────────────── Comunicación de baja (RA) para facturas ───────────────

export interface VoidedItem {
  docType: DocumentType;
  series: string;
  number: number;
  reason: string;
}

export function buildVoidedDocumentsXml(args: {
  issuer: UblIssuer;
  id: string; // RA-YYYYMMDD-n
  referenceDate: string; // fecha de emisión de los comprobantes
  issueDate: string; // fecha de la comunicación
  items: VoidedItem[];
}): string {
  const lines = args.items
    .map(
      (it, i) => `<sac:VoidedDocumentsLine><cbc:LineID>${i + 1}</cbc:LineID><cbc:DocumentTypeCode>${DOC_TYPE_CODE[it.docType]}</cbc:DocumentTypeCode><sac:DocumentSerialID>${it.series}</sac:DocumentSerialID><sac:DocumentNumberID>${it.number}</sac:DocumentNumberID><sac:VoidReasonDescription><![CDATA[${it.reason}]]></sac:VoidReasonDescription></sac:VoidedDocumentsLine>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<VoidedDocuments xmlns="urn:sunat:names:specification:ubl:peru:schema:xsd:VoidedDocuments-1" xmlns:cac="${NS.cac}" xmlns:cbc="${NS.cbc}" xmlns:ds="${NS.ds}" xmlns:ext="${NS.ext}" xmlns:sac="urn:sunat:names:specification:ubl:peru:schema:xsd:SunatAggregateComponents-1">
<ext:UBLExtensions><ext:UBLExtension><ext:ExtensionContent/></ext:UBLExtension></ext:UBLExtensions>
<cbc:UBLVersionID>2.0</cbc:UBLVersionID>
<cbc:CustomizationID>1.0</cbc:CustomizationID>
<cbc:ID>${args.id}</cbc:ID>
<cbc:ReferenceDate>${args.referenceDate}</cbc:ReferenceDate>
<cbc:IssueDate>${args.issueDate}</cbc:IssueDate>
${signatureBlock(args.issuer)}
<cac:AccountingSupplierParty><cbc:CustomerAssignedAccountID>${args.issuer.ruc}</cbc:CustomerAssignedAccountID><cbc:AdditionalAccountID>6</cbc:AdditionalAccountID><cac:Party><cac:PartyLegalEntity><cbc:RegistrationName>${t(args.issuer.legalName)}</cbc:RegistrationName></cac:PartyLegalEntity></cac:Party></cac:AccountingSupplierParty>
${lines}
</VoidedDocuments>`;
}
