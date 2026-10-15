import { D, Decimal, IGV_RATE, ICBPER_RATE, round2, round10, sum, type DecimalInput } from "@/lib/money";
import { isFree, taxGroup, type IgvAffectation } from "@/lib/sunat/catalogs";

export interface LineInput {
  quantity: DecimalInput;
  /** Precio unitario CON IGV (precio de góndola). Para gratuitos: valor referencial. */
  unitPrice: DecimalInput;
  affectation: IgvAffectation;
  /** Descuento de la línea, monto con IGV incluido */
  discount?: DecimalInput;
  /** Cantidad de bolsas plásticas sujetas a ICBPER */
  icbperUnits?: number;
}

export interface LineTotals {
  quantity: Decimal;
  unitPrice: Decimal;   // con IGV (referencial)
  unitValue: Decimal;   // sin IGV, 10 decimales (0 si es gratuito)
  referenceValue: Decimal; // valor referencial unitario (gratuitos)
  discount: Decimal;    // base imponible del descuento (sin IGV)
  lineExtension: Decimal; // valor de venta de la línea (sin IGV)
  igvBase: Decimal;
  igv: Decimal;
  icbper: Decimal;
  lineTotal: Decimal;   // importe cobrado (0 para gratuitos)
  free: boolean;
  affectation: IgvAffectation;
}

export interface DocumentTotals {
  opGravadas: Decimal;
  opExoneradas: Decimal;
  opInafectas: Decimal;
  opExportacion: Decimal;
  opGratuitas: Decimal;
  igvGratuitas: Decimal;
  totalDiscount: Decimal;
  igv: Decimal;
  icbper: Decimal;
  /** Σ valor de venta onerosa (LegalMonetaryTotal/LineExtensionAmount) */
  lineExtension: Decimal;
  taxInclusive: Decimal;
  total: Decimal;
}

const ONE = D(1);

/**
 * Cálculo "precio incluye IGV" (estándar retail): el total de la línea es
 * exactamente qty × precio − descuento, y la base se obtiene descontando el
 * IGV. Así el cliente paga lo que ve en góndola y la diferencia de redondeo
 * queda dentro de la tolerancia de ±1 que valida SUNAT.
 */
export function computeLine(input: LineInput): LineTotals {
  const qty = D(input.quantity);
  const price = D(input.unitPrice);
  const discountGross = D(input.discount ?? 0);
  const group = taxGroup(input.affectation);
  const free = isFree(input.affectation);
  const gross = round2(qty.times(price).minus(discountGross));
  if (gross.isNegative()) throw new RangeError("El descuento supera el importe de la línea");

  const icbper = round2(ICBPER_RATE.times(input.icbperUnits ?? 0));
  const factor = group === "GRAVADO" ? ONE.plus(IGV_RATE) : ONE;

  if (free) {
    // Gratuito: se informa el valor referencial; el cliente paga 0.
    const refValue = round10(price.div(factor));
    const lineExtension = round2(qty.times(refValue));
    const igv = group === "GRAVADO" ? round2(lineExtension.times(IGV_RATE)) : D(0);
    return {
      quantity: qty, unitPrice: price, unitValue: D(0), referenceValue: refValue, discount: D(0),
      lineExtension, igvBase: lineExtension, igv, icbper, lineTotal: icbper, free, affectation: input.affectation,
    };
  }

  const lineExtension = round2(gross.div(factor));
  const igv = gross.minus(lineExtension); // cuadra exacto con el total
  const unitValue = round10(price.div(factor));
  const discount = round2(discountGross.div(factor));
  return {
    quantity: qty, unitPrice: price, unitValue, referenceValue: D(0), discount,
    lineExtension, igvBase: lineExtension, igv: group === "GRAVADO" ? igv : D(0), icbper,
    lineTotal: gross.plus(icbper), free, affectation: input.affectation,
  };
}

export function computeTotals(lines: LineTotals[]): DocumentTotals {
  const by = (pred: (l: LineTotals) => boolean, f: (l: LineTotals) => Decimal): Decimal =>
    sum(lines.filter(pred).map(f));
  const onerous = (g: string) => (l: LineTotals) => !l.free && taxGroup(l.affectation) === g;

  const opGravadas = by(onerous("GRAVADO"), (l) => l.lineExtension);
  const opExoneradas = by(onerous("EXONERADO"), (l) => l.lineExtension);
  const opInafectas = by(onerous("INAFECTO"), (l) => l.lineExtension);
  const opExportacion = by(onerous("EXPORTACION"), (l) => l.lineExtension);
  const opGratuitas = by((l) => l.free, (l) => l.lineExtension);
  const igvGratuitas = by((l) => l.free, (l) => l.igv);
  const igv = by(onerous("GRAVADO"), (l) => l.igv);
  const icbper = sum(lines.map((l) => l.icbper));
  const totalDiscount = sum(lines.map((l) => l.discount));
  const lineExtension = opGravadas.plus(opExoneradas).plus(opInafectas).plus(opExportacion);
  const taxInclusive = lineExtension.plus(igv).plus(icbper);

  return {
    opGravadas, opExoneradas, opInafectas, opExportacion, opGratuitas, igvGratuitas,
    totalDiscount, igv, icbper, lineExtension, taxInclusive, total: taxInclusive,
  };
}
