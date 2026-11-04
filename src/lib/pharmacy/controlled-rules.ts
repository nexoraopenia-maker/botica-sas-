/**
 * El saldo del libro debe coincidir con el stock físico del producto controlado.
 * null = controlado sin movimientos en el libro; undefined = el dato no aplica (no controlado).
 */
export function bookMismatch(totalStock: string, bookBalance: string | null | undefined): boolean {
  if (bookBalance === undefined) return false;
  return Math.abs(Number(totalStock) - Number(bookBalance ?? 0)) >= 0.0005;
}
