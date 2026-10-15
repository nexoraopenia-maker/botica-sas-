import "server-only";
import type { MatchMethod } from "@/generated/prisma/enums";
import type { Tx } from "@/lib/db";
import { embed, toPgVector } from "@/lib/ai/embeddings";

export interface MatchCandidate {
  productId: string;
  name: string;
  score: number;
  method: MatchMethod;
}

export interface MatchResult {
  best: MatchCandidate | null;
  candidates: MatchCandidate[];
  status: "MATCHED" | "NEEDS_REVIEW" | "NEW_PRODUCT";
}

export const AUTO_MATCH = 0.85;
export const MIN_CANDIDATE = 0.45;

/**
 * Emparejamiento por capas (la primera señal fuerte gana):
 *  1. Historial: mismo proveedor, misma descripción normalizada en compras previas (aprende de revisiones humanas).
 *  2. Código exacto: SKU o código de barras = código del proveedor.
 *  3. Trigramas (pg_trgm) sobre nombre y DCI.
 *  4. Vector (pgvector, coseno) si hay embeddings.
 */
export async function matchItem(
  tx: Tx,
  item: { description: string; supplierCode: string | null },
  supplierId: string | null,
  queryVector: number[] | null,
): Promise<MatchResult> {
  const candidates: MatchCandidate[] = [];

  if (supplierId) {
    const hist = await tx.$queryRaw<{ id: string; name: string }[]>`
      SELECT p.id, p.name
        FROM purchase_items pi
        JOIN purchases pu ON pu.id = pi.purchase_id AND pu.status = 'RECEIVED'
        JOIN products p ON p.id = pi.product_id AND p.deleted_at IS NULL
       WHERE pu.supplier_id = ${supplierId}::uuid
         AND app.search_key(pi.description) = app.search_key(${item.description})
       ORDER BY pu.issue_date DESC LIMIT 1`;
    if (hist[0]) candidates.push({ productId: hist[0].id, name: hist[0].name, score: 0.98, method: "EXACT_CODE" });
  }

  if (item.supplierCode) {
    const exact = await tx.$queryRaw<{ id: string; name: string }[]>`
      SELECT id, name FROM products
       WHERE deleted_at IS NULL AND (sku = ${item.supplierCode} OR barcode = ${item.supplierCode}) LIMIT 1`;
    if (exact[0]) candidates.push({ productId: exact[0].id, name: exact[0].name, score: 1, method: "EXACT_CODE" });
  }

  const trigram = await tx.$queryRaw<{ id: string; name: string; score: number }[]>`
    SELECT id, name,
           greatest(similarity(app.search_key(name), app.search_key(${item.description})),
                    coalesce(similarity(app.search_key(dci), app.search_key(${item.description})), 0))::float8 AS score
      FROM products
     WHERE deleted_at IS NULL
       AND (app.search_key(name) % app.search_key(${item.description})
            OR (dci IS NOT NULL AND app.search_key(dci) % app.search_key(${item.description})))
     ORDER BY score DESC LIMIT 5`;
  candidates.push(...trigram.map((r) => ({ productId: r.id, name: r.name, score: Number(r.score), method: "TRIGRAM" as const })));

  if (queryVector) {
    const vec = toPgVector(queryVector);
    const sem = await tx.$queryRaw<{ id: string; name: string; score: number }[]>`
      SELECT id, name, (1 - (embedding <=> ${vec}::vector))::float8 AS score
        FROM products
       WHERE deleted_at IS NULL AND embedding IS NOT NULL
       ORDER BY embedding <=> ${vec}::vector LIMIT 5`;
    candidates.push(...sem.map((r) => ({ productId: r.id, name: r.name, score: Number(r.score) * 0.95, method: "VECTOR" as const })));
  }

  // Dedup por producto, conservando el mejor puntaje
  const best = new Map<string, MatchCandidate>();
  for (const c of candidates) {
    const prev = best.get(c.productId);
    if (!prev || c.score > prev.score) best.set(c.productId, c);
  }
  const ranked = [...best.values()].filter((c) => c.score >= MIN_CANDIDATE).sort((a, b) => b.score - a.score).slice(0, 5);
  const top = ranked[0] ?? null;
  // Ambigüedad: dos candidatos casi empatados → revisión humana
  const ambiguous = ranked.length > 1 && top !== null && top.score - ranked[1]!.score < 0.05 && top.method !== "EXACT_CODE";
  const status = !top ? "NEW_PRODUCT" : top.score >= AUTO_MATCH && !ambiguous ? "MATCHED" : "NEEDS_REVIEW";
  return { best: top, candidates: ranked, status };
}

export async function embedDescriptions(descriptions: string[]): Promise<(number[] | null)[]> {
  const vectors = await embed(descriptions);
  return descriptions.map((_, i) => vectors?.[i] ?? null);
}
