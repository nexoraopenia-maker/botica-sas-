import { D, round2, type Decimal, type DecimalInput } from "@/lib/money";

/** Saldo que gana una compra: % de lo pagado con dinero. Lo pagado con monedero no vuelve a generar saldo. */
export function earnAmount(total: DecimalInput, redeemed: DecimalInput, percent: DecimalInput): Decimal {
  const base = D(total).minus(redeemed);
  return base.lte(0) ? D(0) : round2(base.times(percent).div(100));
}

/**
 * Efecto de una nota de crédito, proporcional a lo devuelto. Se quita lo ganado hasta donde alcance el saldo
 * (el cliente pudo haberlo gastado) y se devuelve lo que pagó con monedero.
 */
export function creditNoteEffect(o: { noteTotal: DecimalInput; saleTotal: DecimalInput; earned: DecimalInput; redeemed: DecimalInput; balance: DecimalInput }): { reverse: Decimal; refund: Decimal } {
  const saleTotal = D(o.saleTotal);
  if (saleTotal.lte(0)) return { reverse: D(0), refund: D(0) };
  const ratio = D(o.noteTotal).div(saleTotal);
  const refund = round2(D(o.redeemed).times(ratio));
  const wanted = round2(D(o.earned).times(ratio));
  const available = D(o.balance).plus(refund);
  return { reverse: wanted.gt(available) ? available : wanted, refund };
}
