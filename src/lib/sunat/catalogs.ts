import type { DocumentType, IdentityDocType } from "@/generated/prisma/enums";

/** Catálogo 01 — Tipo de documento */
export const DOC_TYPE_CODE: Record<DocumentType, "01" | "03" | "07" | "08"> = {
  FACTURA: "01",
  BOLETA: "03",
  NOTA_CREDITO: "07",
  NOTA_DEBITO: "08",
};

/** Catálogo 06 — Documento de identidad */
export const IDENTITY_CODE: Record<IdentityDocType, "0" | "1" | "4" | "6" | "7"> = {
  NO_DOC: "0",
  DNI: "1",
  CE: "4",
  RUC: "6",
  PASSPORT: "7",
};

/** Catálogo 07 — Afectación del IGV */
export const IGV_AFFECTATIONS = [
  "10", "11", "12", "13", "14", "15", "16", "17",
  "20", "21",
  "30", "31", "32", "33", "34", "35", "36", "37",
  "40",
] as const;
export type IgvAffectation = (typeof IGV_AFFECTATIONS)[number];

export type TaxGroup = "GRAVADO" | "EXONERADO" | "INAFECTO" | "EXPORTACION";

export interface TaxScheme {
  /** Catálogo 05 */
  id: "1000" | "9995" | "9996" | "9997" | "9998" | "7152";
  name: "IGV" | "EXP" | "GRA" | "EXO" | "INA" | "ICBPER";
  typeCode: "VAT" | "FRE" | "OTH";
}

export const TAX_SCHEMES = {
  IGV: { id: "1000", name: "IGV", typeCode: "VAT" },
  EXP: { id: "9995", name: "EXP", typeCode: "FRE" },
  GRA: { id: "9996", name: "GRA", typeCode: "FRE" },
  EXO: { id: "9997", name: "EXO", typeCode: "VAT" },
  INA: { id: "9998", name: "INA", typeCode: "FRE" },
  ICBPER: { id: "7152", name: "ICBPER", typeCode: "OTH" },
} as const satisfies Record<string, TaxScheme>;

export function taxGroup(a: IgvAffectation): TaxGroup {
  if (a.startsWith("1")) return "GRAVADO";
  if (a.startsWith("2")) return "EXONERADO";
  if (a.startsWith("3")) return "INAFECTO";
  return "EXPORTACION";
}

/** Operaciones gratuitas: todo lo que no es 10, 20, 30, 40 */
export const isFree = (a: IgvAffectation): boolean => !["10", "20", "30", "40"].includes(a);

/** Tributo con el que se informa la línea (catálogo 05 según afectación) */
export function lineTaxScheme(a: IgvAffectation): TaxScheme {
  switch (taxGroup(a)) {
    case "GRAVADO":
      return isFree(a) ? TAX_SCHEMES.GRA : TAX_SCHEMES.IGV;
    case "EXONERADO":
      return isFree(a) ? TAX_SCHEMES.GRA : TAX_SCHEMES.EXO;
    case "INAFECTO":
      return isFree(a) ? TAX_SCHEMES.GRA : TAX_SCHEMES.INA;
    case "EXPORTACION":
      return TAX_SCHEMES.EXP;
  }
}

/** Catálogo 09 — Motivos de Nota de Crédito */
export const CREDIT_NOTE_REASONS = {
  "01": "Anulación de la operación",
  "02": "Anulación por error en el RUC",
  "03": "Corrección por error en la descripción",
  "04": "Descuento global",
  "05": "Descuento por ítem",
  "06": "Devolución total",
  "07": "Devolución por ítem",
  "08": "Bonificación",
  "09": "Disminución en el valor",
  "10": "Otros conceptos",
  "13": "Ajustes – montos y/o fechas de pago",
} as const;
export type CreditNoteReason = keyof typeof CREDIT_NOTE_REASONS;

/** Catálogo 10 — Motivos de Nota de Débito */
export const DEBIT_NOTE_REASONS = {
  "01": "Intereses por mora",
  "02": "Aumento en el valor",
  "03": "Penalidades / otros conceptos",
} as const;
export type DebitNoteReason = keyof typeof DEBIT_NOTE_REASONS;

/** Motivos de NC que reponen stock (devolución) */
export const RESTOCKING_CREDIT_REASONS: readonly CreditNoteReason[] = ["01", "06", "07"];

/** Catálogo 03 — subset de unidades de medida usadas en los rubros */
export const UNIT_CODES = {
  NIU: "Unidad (bienes)",
  ZZ: "Unidad (servicios)",
  KGM: "Kilogramo",
  GRM: "Gramo",
  LTR: "Litro",
  MLT: "Mililitro",
  BX: "Caja",
  BG: "Bolsa",
  BO: "Botella",
  DZN: "Docena",
  PK: "Paquete",
  SA: "Saco",
  TU: "Tubo",
  VI: "Vial",
  AV: "Cápsula",
  TAB: "Tableta",
  AM: "Ampolla",
  ST: "Blíster (hoja)",
} as const;
export type UnitCode = keyof typeof UNIT_CODES;
