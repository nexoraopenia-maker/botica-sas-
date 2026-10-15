/**
 * Clasificación de respuestas SUNAT (Anexo "Códigos de error").
 *  • 0           → aceptado
 *  • 0100–1999   → excepción: el comprobante NO fue registrado
 *  • 2000–3999   → rechazo (definitivo: emitir otro comprobante)
 *  • 4000+       → observación (aceptado con observaciones)
 */
export type SunatOutcome =
  | { kind: "ACCEPTED"; code: string; description: string; notes: string[] }
  | { kind: "ACCEPTED_WITH_OBS"; code: string; description: string; notes: string[] }
  | { kind: "REJECTED"; code: string; description: string }
  | { kind: "ALREADY_REGISTERED"; code: string; description: string }
  | { kind: "RETRYABLE"; code: string; description: string }
  | { kind: "CONFIG_ERROR"; code: string; description: string }
  | { kind: "EXCEPTION"; code: string; description: string };

/** Errores transitorios del servicio: reintentar con backoff. */
const RETRYABLE = new Set([
  "0100", "0109", "0110", "0130", "0131", "0132", "0133", "0134", "0135", "0136", "0137", "0138",
  "0200", "0201", "0202", "0203", "0204", "0250", "0251", "0252", "0253", "0254", "0255",
  "0402", "1078", "2010",
]);

/** Credenciales / certificado: no se reintenta hasta que el tenant corrija la configuración. */
const CONFIG = new Set([
  "0102", "0103", "0104", "0105", "0106", "0111", "0112", "0113", "0151", "0152", "0153", "0154",
  "0155", "0156", "2325", "2326", "2327", "2328", "2333", "2334", "2335",
]);

/** Ya registrado: recuperar el CDR vía consulta en vez de reenviar. */
const ALREADY = new Set(["1032", "1033"]);

export function classifySunatCode(rawCode: string, description: string, notes: string[] = []): SunatOutcome {
  const code = rawCode.replace(/\D/g, "").replace(/^0+(?=\d{4})/, "").padStart(4, "0");
  const n = Number(code);
  if (n === 0) {
    return notes.length > 0
      ? { kind: "ACCEPTED_WITH_OBS", code: "0", description, notes }
      : { kind: "ACCEPTED", code: "0", description, notes };
  }
  if (ALREADY.has(code)) return { kind: "ALREADY_REGISTERED", code, description };
  if (RETRYABLE.has(code)) return { kind: "RETRYABLE", code, description };
  if (CONFIG.has(code)) return { kind: "CONFIG_ERROR", code, description };
  if (n >= 4000) return { kind: "ACCEPTED_WITH_OBS", code, description, notes: [description, ...notes] };
  if (n >= 2000) return { kind: "REJECTED", code, description };
  return { kind: "EXCEPTION", code, description };
}

/** Backoff exponencial con jitter: 30s, 1m, 2m, 4m … tope 6h. */
export function nextRetryDelayMs(attempt: number): number {
  const base = Math.min(30_000 * 2 ** Math.max(0, attempt - 1), 6 * 3_600_000);
  return Math.round(base * (0.8 + Math.random() * 0.4));
}
