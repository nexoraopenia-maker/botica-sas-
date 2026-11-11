/** Filtro por categoría de la caja. Sin acceso a datos: corre en el navegador. */

/** Valor del filtro para los productos sin categoría */
export const NO_CATEGORY = "__none";

interface Categorized { categoryId: string | null; categoryName: string | null }

export interface CategoryOption { id: string; name: string; count: number }

/** Categorías con productos, ordenadas por nombre, y cuántos productos no tienen categoría. */
export function categoryOptions(products: readonly Categorized[]): { options: CategoryOption[]; uncategorized: number } {
  const by = new Map<string, CategoryOption>();
  let uncategorized = 0;
  for (const p of products) {
    if (!p.categoryId || !p.categoryName) { uncategorized++; continue; }
    const o = by.get(p.categoryId) ?? { id: p.categoryId, name: p.categoryName, count: 0 };
    o.count++;
    by.set(p.categoryId, o);
  }
  return { options: [...by.values()].sort((a, b) => a.name.localeCompare(b.name, "es")), uncategorized };
}

/** `selected` null = todas. */
export function inCategory(p: Categorized, selected: string | null): boolean {
  if (selected === null) return true;
  return selected === NO_CATEGORY ? !p.categoryId : p.categoryId === selected;
}
