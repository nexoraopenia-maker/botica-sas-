import { D, type Decimal } from "@/lib/money";

export const CLOSURE_METHODS = ["EFECTIVO", "YAPE", "PLIN", "TARJETA"] as const;
export type ClosureMethod = (typeof CLOSURE_METHODS)[number];

export interface ClosureLine { method: ClosureMethod; expected: string; counted: string; difference: string; refunds: string }
export interface ClosureResult { lines: ClosureLine[]; expectedTotal: string; countedTotal: string; difference: string }

/** Esperado = ventas − devoluciones por medio de pago; en efectivo se suma el fondo inicial. Diferencia = contado − esperado. */
export function computeClosure(
  opening: Decimal | string | number,
  sales: Record<ClosureMethod, Decimal | string | number>,
  counted: Record<ClosureMethod, Decimal | string | number>,
  refunds: Partial<Record<ClosureMethod, Decimal | string | number>> = {},
): ClosureResult {
  let expectedTotal = D(0), countedTotal = D(0);
  const lines = CLOSURE_METHODS.map((method) => {
    const refunded = D(refunds[method] ?? 0);
    const expected = D(sales[method]).minus(refunded).plus(method === "EFECTIVO" ? D(opening) : 0);
    const c = D(counted[method]);
    expectedTotal = expectedTotal.plus(expected);
    countedTotal = countedTotal.plus(c);
    return { method, expected: expected.toFixed(2), counted: c.toFixed(2), difference: c.minus(expected).toFixed(2), refunds: refunded.toFixed(2) };
  });
  return { lines, expectedTotal: expectedTotal.toFixed(2), countedTotal: countedTotal.toFixed(2), difference: countedTotal.minus(expectedTotal).toFixed(2) };
}
