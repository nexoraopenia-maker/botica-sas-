import { XMLParser } from "fast-xml-parser";
import type { ExtractedInvoice, ExtractedItem } from "@/lib/ai/ingestion/schema";

const parser = new XMLParser({ removeNSPrefix: true, ignoreAttributes: false, attributeNamePrefix: "@", parseTagValue: false });

type Node = Record<string, unknown>;
const get = (o: unknown, ...path: string[]): unknown =>
  path.reduce<unknown>((acc, k) => (acc && typeof acc === "object" ? (acc as Node)[k] : undefined), o);
const text = (v: unknown): string | null => {
  if (v === undefined || v === null) return null;
  if (typeof v === "object") return text((v as Node)["#text"]);
  const s = String(v).trim();
  return s.length ? s : null;
};
const asArray = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

const LOT_RE = /\b(?:LOTE|LOT|L)\s*[:.#-]?\s*([A-Z0-9][A-Z0-9-]{2,20})/i;
// dd/mm/aaaa | dd/mm/aa | mm/aaaa
const EXP_RE = /\b(?:F\.?\s?V\.?|VENC(?:E|IMIENTO)?\.?|EXP(?:IRA)?\.?)\s*[:.]?\s*(?:(\d{1,2})[/-](\d{1,2})[/-](\d{4}|\d{2})|(\d{1,2})[/-](\d{4}))(?!\d)/i;

/** Extrae lote/vencimiento escritos dentro de la descripción ("LOTE: A123 F.V. 12/2027"). */
export function extractLotExpiry(description: string): { lot: string | null; expiry: string | null } {
  const lot = LOT_RE.exec(description)?.[1]?.toUpperCase() ?? null;
  const m = EXP_RE.exec(description);
  let expiry: string | null = null;
  if (m) {
    const [, dd, mm, yy, onlyMonth, onlyYear] = m;
    let year: number;
    let month: number;
    let day: number | null;
    if (yy) {
      day = Number(dd); month = Number(mm); year = Number(yy.length === 2 ? `20${yy}` : yy);
    } else {
      month = Number(onlyMonth); year = Number(onlyYear); day = null;
    }
    if (month >= 1 && month <= 12 && year >= 2000) {
      const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
      const d = day && day >= 1 && day <= last ? day : last;
      expiry = `${year}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    }
  }
  return { lot, expiry };
}

const AFFECTATION: Record<string, ExtractedItem["igv_affectation"]> = { "1": "GRAVADO", "2": "EXONERADO", "3": "INAFECTO" };

/** Lectura determinista del XML UBL 2.1 del proveedor (sin IA, confianza 1). */
export function parseSupplierUbl(xml: string): ExtractedInvoice {
  const doc = parser.parse(xml) as Node;
  const root = (get(doc, "Invoice") ?? get(doc, "CreditNote")) as Node | undefined;
  if (!root) throw new Error("El XML no es un comprobante UBL (Invoice)");
  const [series, number] = (text(get(root, "ID")) ?? "").split("-");
  const typeCode = text(get(root, "InvoiceTypeCode"));
  const lines = asArray(get(root, "InvoiceLine") as Node | Node[] | undefined);

  const items: ExtractedItem[] = lines.map((l, idx) => {
    const description = text(get(l, "Item", "Description")) ?? "";
    const { lot, expiry } = extractLotExpiry(description);
    const qtyNode = get(l, "InvoicedQuantity");
    const aff = text(get(asArray(get(l, "TaxTotal", "TaxSubtotal") as Node | Node[])[0], "TaxCategory", "TaxExemptionReasonCode")) ?? "";
    return {
      line_no: Number(text(get(l, "ID")) ?? idx + 1),
      supplier_code: text(get(l, "Item", "SellersItemIdentification", "ID")),
      description,
      quantity: text(qtyNode) ?? "0",
      unit: typeof qtyNode === "object" ? text((qtyNode as Node)["@unitCode"]) : null,
      units_per_package: null,
      unit_price: text(get(l, "Price", "PriceAmount")) ?? "0",
      unit_price_includes_igv: false, // cac:Price es valor unitario sin IGV
      line_total: text(get(l, "LineExtensionAmount")),
      igv_affectation: AFFECTATION[aff.charAt(0)] ?? "DESCONOCIDO",
      lot_code: lot,
      expiry_date: expiry,
      registration_code: null,
      confidence: 1,
    };
  });

  return {
    is_purchase_document: true,
    document_type: typeCode === "03" ? "BOLETA" : get(doc, "CreditNote") ? "NOTA_CREDITO" : "FACTURA",
    supplier: {
      ruc: text(get(root, "AccountingSupplierParty", "Party", "PartyIdentification", "ID")),
      legal_name: text(get(root, "AccountingSupplierParty", "Party", "PartyLegalEntity", "RegistrationName")),
      address: text(get(root, "AccountingSupplierParty", "Party", "PartyLegalEntity", "RegistrationAddress", "AddressLine", "Line")),
    },
    buyer_ruc: text(get(root, "AccountingCustomerParty", "Party", "PartyIdentification", "ID")),
    series: series ?? null,
    number: number ?? null,
    issue_date: text(get(root, "IssueDate")),
    currency: text(get(root, "DocumentCurrencyCode")) === "USD" ? "USD" : "PEN",
    subtotal: text(get(root, "LegalMonetaryTotal", "LineExtensionAmount")),
    igv: text(get(root, "TaxTotal", "TaxAmount")),
    total: text(get(root, "LegalMonetaryTotal", "PayableAmount")),
    items,
    overall_confidence: 1,
    warnings: [],
  };
}
