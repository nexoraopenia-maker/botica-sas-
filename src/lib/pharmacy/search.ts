import "server-only";
import { withTenant, type TenantDbContext } from "@/lib/db";

export interface ProductHit {
  id: string;
  name: string;
  dci: string | null;
  concentration: string | null;
  pharmaceutical_form: string | null;
  laboratory: string | null;
  pharmaceutical_kind: "GENERIC" | "BRAND" | null;
  sale_condition: string | null;
  sale_price: string;
  package_price: string | null;
  units_per_package: number;
  stock: string;
  nearest_expiry: Date | null;
  score: number;
}

export interface SearchResult {
  hits: ProductHit[];
  /** Por producto de marca: genéricos con mismo DCI + concentración + forma, con stock, más baratos primero */
  genericAlternatives: Record<string, ProductHit[]>;
}

/** Búsqueda por nombre comercial o DCI (trigramas, sin tildes) con stock vendible de la sucursal. */
export async function searchProducts(ctx: TenantDbContext, branchId: string, q: string): Promise<SearchResult> {
  const term = q.trim();
  if (term.length < 2) return { hits: [], genericAlternatives: {} };

  return withTenant(ctx, async (tx) => {
    const hits = await tx.$queryRaw<ProductHit[]>`
      WITH stock AS (
        SELECT product_id, sum(stock) AS stock, min(expiry_date) AS nearest_expiry
          FROM product_batches
         WHERE branch_id = ${branchId}::uuid AND stock > 0 AND deleted_at IS NULL AND NOT is_quarantined
           AND (expiry_date IS NULL OR expiry_date >= app.lima_today())
         GROUP BY product_id
      )
      SELECT p.id, p.name, p.dci, p.concentration, p.pharmaceutical_form, p.laboratory,
             p.pharmaceutical_kind::text AS pharmaceutical_kind, p.sale_condition::text AS sale_condition,
             p.sale_price::text, p.package_price::text, p.units_per_package,
             coalesce(s.stock, 0)::text AS stock, s.nearest_expiry,
             greatest(similarity(app.search_key(p.name), app.search_key(${term})),
                      coalesce(similarity(app.search_key(p.dci), app.search_key(${term})), 0),
                      CASE WHEN p.barcode = ${term} OR p.sku = ${term} THEN 1 ELSE 0 END)::float8 AS score
        FROM products p
        LEFT JOIN stock s ON s.product_id = p.id
       WHERE p.deleted_at IS NULL AND p.is_active
         AND (app.search_key(p.name) % app.search_key(${term})
              OR app.search_key(p.name) LIKE '%' || app.search_key(${term}) || '%'
              OR (p.dci IS NOT NULL AND app.search_key(p.dci) LIKE '%' || app.search_key(${term}) || '%')
              OR p.barcode = ${term} OR p.sku = ${term})
       ORDER BY score DESC, p.name
       LIMIT 25`;

    const brands = hits.filter((h) => h.pharmaceutical_kind === "BRAND" && h.dci);
    const genericAlternatives: Record<string, ProductHit[]> = {};
    for (const b of brands) {
      genericAlternatives[b.id] = await tx.$queryRaw<ProductHit[]>`
        SELECT p.id, p.name, p.dci, p.concentration, p.pharmaceutical_form, p.laboratory,
               p.pharmaceutical_kind::text AS pharmaceutical_kind, p.sale_condition::text AS sale_condition,
               p.sale_price::text, p.package_price::text, p.units_per_package,
               sum(b.stock)::text AS stock, min(b.expiry_date) AS nearest_expiry, 1::float8 AS score
          FROM products p
          JOIN product_batches b ON b.product_id = p.id AND b.branch_id = ${branchId}::uuid AND b.stock > 0
               AND b.deleted_at IS NULL AND NOT b.is_quarantined AND (b.expiry_date IS NULL OR b.expiry_date >= app.lima_today())
         WHERE p.deleted_at IS NULL AND p.is_active AND p.pharmaceutical_kind = 'GENERIC'
           AND app.search_key(p.dci) = app.search_key(${b.dci})
           AND coalesce(app.search_key(p.concentration), '') = coalesce(app.search_key(${b.concentration}), '')
           AND coalesce(app.search_key(p.pharmaceutical_form), '') = coalesce(app.search_key(${b.pharmaceutical_form}), '')
         GROUP BY p.id
         ORDER BY p.sale_price ASC
         LIMIT 5`;
    }
    return { hits, genericAlternatives };
  });
}
