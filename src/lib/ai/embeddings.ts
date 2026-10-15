import "server-only";
import { env } from "@/lib/env";

/**
 * Embeddings para emparejamiento semántico (pgvector, 1024 dims).
 * Proveedor: Voyage AI vía REST (sin SDK adicional). Opcional: si no hay
 * VOYAGE_API_KEY, el emparejamiento usa solo historial + código + trigramas.
 */
export const EMBEDDING_DIMS = 1024;

export async function embed(texts: string[]): Promise<number[][] | null> {
  const key = env().VOYAGE_API_KEY;
  if (!key || texts.length === 0) return null;
  const res = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: "voyage-3.5", input: texts, input_type: "document", output_dimension: EMBEDDING_DIMS }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) return null; // degradación elegante: seguimos sin vector
  const json = (await res.json()) as { data: { embedding: number[]; index: number }[] };
  return json.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
}

export const toPgVector = (v: number[]): string => `[${v.join(",")}]`;
