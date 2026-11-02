import { D, type Decimal } from "@/lib/money";

/*
 * Libros electrónicos PLE 5.2 de SUNAT (Anexo 2, RS 286-2009/SUNAT y modificatorias):
 *   14.1 Registro de Ventas e Ingresos → 35 campos · 8.1 Registro de Compras → 42 campos.
 * Campos separados y terminados en "|", una operación por línea. Puro: sin acceso a datos.
 */
export const PLE_BOOKS = {
  sales: { code: "140100", fields: 35, label: "Registro de Ventas e Ingresos (14.1)" },
  purchases: { code: "080100", fields: 42, label: "Registro de Compras (8.1)" },
} as const;
export type PleBook = keyof typeof PLE_BOOKS;

/** LE + RUC + AAAA + MM + 00 + libro + 00 + O(1 = operativa) + I(contenido) + M(1 = soles) + G(1). */
export function pleFileName(ruc: string, period: string, book: PleBook, hasData: boolean): string {
  return `LE${ruc}${period.slice(0, 4)}${period.slice(5, 7)}00${PLE_BOOKS[book].code}001${hasData ? "1" : "0"}11.TXT`;
}

const amt = (v: Decimal | string | number): string => D(v).toFixed(2);
const pleDate = (d: Date): string => { const i = d.toISOString(); return `${i.slice(8, 10)}/${i.slice(5, 7)}/${i.slice(0, 4)}`; };
/** Los separadores y saltos de línea dentro de un texto romperían la estructura del archivo. */
const text = (v: string, max: number): string => v.replace(/[|\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
const seq = (period: string, n: number) => ({ cuo: `${period.replace("-", "")}${String(n).padStart(6, "0")}`, entry: `M${n}` });
const periodField = (period: string) => `${period.replace("-", "")}00`;

export interface PleSale {
  docCode: "01" | "03" | "07" | "08";
  series: string;
  number: number;
  issueDate: Date;
  customerDocCode: string;
  customerDoc: string;
  customerName: string;
  gravada: Decimal | string;
  exonerada: Decimal | string;
  inafecta: Decimal | string;
  igv: Decimal | string;
  icbper: Decimal | string;
  total: Decimal | string;
  voided: boolean;
  ref: { date: Date; docCode: string; series: string; number: number } | null;
}

export function saleLine(s: PleSale, period: string, n: number): string {
  const { cuo, entry } = seq(period, n);
  // Notas de crédito restan: montos negativos
  const sign = s.docCode === "07" ? -1 : 1;
  const m = (v: Decimal | string) => (s.voided ? "0.00" : amt(D(v).times(sign)));
  const f = [
    periodField(period), cuo, entry, pleDate(s.issueDate), "", s.docCode, s.series, String(s.number), "",
    s.voided ? "" : s.customerDocCode, s.voided ? "" : text(s.customerDoc, 15), s.voided ? "" : text(s.customerName, 100),
    "0.00", m(s.gravada), "0.00", m(s.igv), "0.00", m(s.exonerada), m(s.inafecta), "0.00", "0.00", "0.00",
    m(s.icbper), "0.00", m(s.total), "PEN", "1.000",
    s.ref ? pleDate(s.ref.date) : "", s.ref?.docCode ?? "", s.ref?.series ?? "", s.ref ? String(s.ref.number) : "",
    "", "", "", s.voided ? "2" : "1",
  ];
  return `${f.join("|")}|`;
}

export interface PlePurchase {
  docCode: string;
  series: string;
  number: string;
  issueDate: Date;
  supplierRuc: string;
  supplierName: string;
  /** Parte de la compra sin IGV (exonerada/inafecta) */
  nonTaxable: Decimal | string;
  subtotal: Decimal | string;
  igv: Decimal | string;
  total: Decimal | string;
  currency: string;
  exchangeRate: Decimal | string | null;
}

export function purchaseLine(p: PlePurchase, period: string, n: number): string {
  const { cuo, entry } = seq(period, n);
  const usd = p.currency !== "PEN";
  const rate = usd ? D(p.exchangeRate ?? 0) : D(1);
  const pen = (v: Decimal | string) => D(v).times(rate);
  // Boleta: sin derecho a crédito fiscal → todo va como no gravado y estado 0
  const credit = p.docCode === "01";
  const total = pen(p.total);
  const base = credit ? pen(p.subtotal).minus(pen(p.nonTaxable)) : D(0);
  const igv = credit ? pen(p.igv) : D(0);
  const nonTax = credit ? pen(p.nonTaxable) : total;
  // El campo 24 debe ser la suma de los campos 14 a 23: cualquier resto (redondeo, otros cargos) va al 23
  const other = total.minus(base).minus(igv).minus(nonTax);
  const f = [
    periodField(period), cuo, entry, pleDate(p.issueDate), "", p.docCode, text(p.series, 20), "", text(p.number, 20), "",
    "6", p.supplierRuc, text(p.supplierName, 100),
    amt(base), amt(igv), "0.00", "0.00", "0.00", "0.00", amt(nonTax), "0.00", "0.00", amt(other), amt(total),
    usd ? p.currency : "PEN", usd ? rate.toFixed(3) : "1.000",
    "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", credit ? "1" : "0",
  ];
  return `${f.join("|")}|`;
}

/** SUNAT carga texto plano ANSI con fin de línea CRLF; sin operaciones, el archivo va vacío. */
export const pleFile = (lines: string[]): Buffer => Buffer.from(lines.length ? `${lines.join("\r\n")}\r\n` : "", "latin1");
