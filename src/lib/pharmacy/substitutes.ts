/** Búsqueda farmacológica y sustitutos en la caja. Sin dependencias de servidor: corre en el navegador. */

export interface PharmaProduct {
  id: string;
  name: string;
  sku: string;
  barcode: string | null;
  dci: string | null;
  concentration: string | null;
  pharmaceuticalForm: string | null;
  laboratory: string | null;
  therapeuticAction: string | null;
  pharmaceuticalKind: "GENERIC" | "BRAND" | null;
  salePrice: string;
  available: string;
  tracksBatches: boolean;
  isService: boolean;
}

/** Minúsculas sin tildes ni espacios repetidos: "Paracetamol  500 MG" = "paracetamol 500 mg". */
export const searchKey = (s: string | null | undefined): string =>
  (s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();

/** Concentración comparable: "500mg", "500 MG" y "500 mg." son la misma. */
const doseKey = (s: string | null | undefined): string => searchKey(s).replace(/[\s.]/g, "");

/** Coincide por nombre, código, principio activo (DCI), acción terapéutica o laboratorio. Todas las palabras deben aparecer. */
export function matchesSearch(p: PharmaProduct, query: string): boolean {
  const words = searchKey(query).split(" ").filter(Boolean);
  if (words.length === 0) return true;
  const hay = searchKey([p.name, p.sku, p.barcode, p.dci, p.therapeuticAction, p.laboratory].filter(Boolean).join(" "));
  return words.every((w) => hay.includes(w));
}

export interface Substitute<T extends PharmaProduct> {
  product: T;
  /** Cuánto más barato es por unidad (positivo = ahorro) */
  saving: number;
}

/**
 * Equivalentes farmacéuticos: mismo principio activo, concentración y forma farmacéutica, con stock.
 * No se sugiere por acción terapéutica: cambiar de principio activo es decisión del prescriptor.
 * Orden: genéricos primero, luego el más barato.
 */
export function findSubstitutes<T extends PharmaProduct>(product: T, catalog: readonly T[], limit = 5): Substitute<T>[] {
  if (!product.dci) return [];
  const dci = searchKey(product.dci);
  const dose = doseKey(product.concentration);
  const form = searchKey(product.pharmaceuticalForm);
  const price = Number(product.salePrice);
  return catalog
    .filter((p) => p.id !== product.id && searchKey(p.dci) === dci && doseKey(p.concentration) === dose && searchKey(p.pharmaceuticalForm) === form)
    .filter((p) => p.isService || !p.tracksBatches || Number(p.available) > 0)
    .map((p) => ({ product: p, saving: Math.round((price - Number(p.salePrice)) * 100) / 100 }))
    .sort((a, b) => Number(b.product.pharmaceuticalKind === "GENERIC") - Number(a.product.pharmaceuticalKind === "GENERIC") || Number(a.product.salePrice) - Number(b.product.salePrice))
    .slice(0, limit);
}
