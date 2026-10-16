/** Validación de códigos GTIN (EAN-13, EAN-8, UPC-A, GTIN-14) por dígito verificador. */
export function isValidGtin(code: string): boolean {
  if (!/^\d{8}$|^\d{12,14}$/.test(code)) return false;
  const digits = code.split("").map(Number);
  const check = digits.pop()!;
  const sum = digits.reverse().reduce((acc, d, i) => acc + d * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === check;
}

/** Numérico de longitud GTIN pero con verificador inválido: probable error de tipeo o lectura. */
export const looksLikeBrokenGtin = (code: string): boolean => /^\d{8}$|^\d{12,14}$/.test(code) && !isValidGtin(code);

export const normalizeCode = (code: string): string => code.trim().replace(/\s+/g, "");
