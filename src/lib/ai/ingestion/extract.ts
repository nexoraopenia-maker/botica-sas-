import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { env } from "@/lib/env";
import { INGESTION_SYSTEM_PROMPT, ingestionUserPrompt } from "@/lib/ai/ingestion/prompt";
import { extractedInvoiceSchema, type ExtractedInvoice } from "@/lib/ai/ingestion/schema";

export const INGESTION_MODEL = "claude-opus-5-5";
/** Extracción de facturas: tarea acotada. Subir a "high" si la evaluación muestra errores de lectura. */
const INGESTION_EFFORT = "medium" as const;

const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"] as const;
type ImageMediaType = (typeof IMAGE_TYPES)[number];

export type ExtractionOutcome =
  | { ok: true; data: ExtractedInvoice; model: string; inputTokens: number; outputTokens: number }
  | { ok: false; retryable: boolean; error: string };

let client: Anthropic | undefined;
function anthropic(): Anthropic {
  const apiKey = env().ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY no configurada");
  client ??= new Anthropic({ apiKey, maxRetries: 2, timeout: 120_000 });
  return client;
}

/** Visión/OCR con Claude + salida estructurada validada con Zod. */
export async function extractInvoice(
  file: Buffer,
  mimeType: string,
  ctx: { tenantRuc: string; tenantName: string; businessLines: string[] },
): Promise<ExtractionOutcome> {
  const data = file.toString("base64");
  const media: Anthropic.Beta.BetaContentBlockParam =
    mimeType === "application/pdf"
      ? { type: "document", source: { type: "base64", media_type: "application/pdf", data } }
      : IMAGE_TYPES.includes(mimeType as ImageMediaType)
        ? { type: "image", source: { type: "base64", media_type: mimeType as ImageMediaType, data } }
        : (() => {
            throw new Error(`Tipo de archivo no soportado: ${mimeType}`);
          })();

  try {
    const response = await anthropic().beta.messages.parse({
      model: INGESTION_MODEL,
      max_tokens: 16_000,
      // Si el modelo declina por políticas, el servidor reintenta con su fallback por defecto
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      thinking: { type: "adaptive" },
      output_config: { effort: INGESTION_EFFORT, format: betaZodOutputFormat(extractedInvoiceSchema) },
      system: INGESTION_SYSTEM_PROMPT,
      messages: [{ role: "user", content: [media, { type: "text", text: ingestionUserPrompt(ctx) }] }],
    });

    if (response.stop_reason === "refusal") {
      return { ok: false, retryable: false, error: "El modelo no procesó el documento (refusal)." };
    }
    if (response.stop_reason === "max_tokens") {
      return { ok: false, retryable: false, error: "Documento demasiado extenso: divídalo en páginas." };
    }
    const parsed = response.parsed_output ? extractedInvoiceSchema.safeParse(response.parsed_output) : null;
    if (!parsed?.success) {
      return { ok: false, retryable: true, error: "La respuesta no cumplió el esquema esperado." };
    }
    return {
      ok: true,
      data: parsed.data,
      model: response.model,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    };
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) return { ok: false, retryable: true, error: "Límite de uso de IA alcanzado; se reintentará." };
    if (err instanceof Anthropic.InternalServerError) return { ok: false, retryable: true, error: "Servicio de IA no disponible; se reintentará." };
    if (err instanceof Anthropic.BadRequestError) return { ok: false, retryable: false, error: `Solicitud inválida: ${err.message}` };
    if (err instanceof Anthropic.APIConnectionError) return { ok: false, retryable: true, error: "Sin conexión con el servicio de IA." };
    throw err;
  }
}
