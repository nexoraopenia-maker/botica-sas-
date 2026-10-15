import { D } from "@/lib/money";
import { isValidRuc } from "@/lib/sunat/validation";
import type { ExtractedInvoice } from "@/lib/ai/ingestion/schema";

export const LOW_CONFIDENCE = 0.75;

/** Validaciones cruzadas: lo que el modelo no puede garantizar, lo verifica el servidor. */
export function sanityCheck(inv: ExtractedInvoice, tenantRuc: string, today: Date): string[] {
  const w: string[] = [];
  if (!inv.is_purchase_document) w.push("El archivo no parece ser un comprobante de compra.");
  if (!inv.supplier.ruc) w.push("No se pudo leer el RUC del proveedor.");
  else if (!isValidRuc(inv.supplier.ruc)) w.push(`RUC del proveedor ${inv.supplier.ruc} no supera el dígito verificador.`);
  if (inv.buyer_ruc && inv.buyer_ruc !== tenantRuc) {
    w.push(`El comprobante está emitido al RUC ${inv.buyer_ruc}, no a su negocio (${tenantRuc}): no sustenta crédito fiscal.`);
  }
  if (!inv.series || !inv.number) w.push("Falta serie o número del comprobante.");
  if (inv.issue_date && new Date(`${inv.issue_date}T00:00:00Z`) > today) w.push("La fecha de emisión es futura.");

  const lineSum = inv.items.reduce((acc, it) => acc.plus(D(it.line_total ?? D(it.quantity).times(it.unit_price))), D(0));
  if (inv.subtotal && inv.total) {
    const sub = D(inv.subtotal);
    const tot = D(inv.total);
    const igv = D(inv.igv ?? 0);
    if (sub.plus(igv).minus(tot).abs().gt(1)) w.push("Subtotal + IGV no coincide con el total del comprobante.");
    const target = inv.items.every((i) => i.unit_price_includes_igv) ? tot : sub;
    if (target.gt(0) && lineSum.minus(target).abs().div(target).gt(0.01)) {
      w.push(`La suma de líneas (${lineSum.toFixed(2)}) difiere más de 1% del comprobante (${target.toFixed(2)}): posible línea omitida o mal leída.`);
    }
  }
  for (const it of inv.items) {
    if (it.expiry_date && new Date(`${it.expiry_date}T00:00:00Z`) < today) {
      w.push(`Línea ${it.line_no}: el lote ${it.lot_code ?? "?"} ya está vencido (${it.expiry_date}).`);
    }
    if (D(it.quantity).lte(0)) w.push(`Línea ${it.line_no}: cantidad inválida.`);
  }
  if (inv.overall_confidence < LOW_CONFIDENCE) w.push("Lectura de baja confianza: revise todos los campos contra el documento.");
  return w;
}
