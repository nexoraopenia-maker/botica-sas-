import { z } from "zod";

export type ActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; fieldErrors?: Record<string, string[]> } };

export class DomainError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "DomainError";
  }
}

export const ok = <T>(data: T): ActionResult<T> => ({ ok: true, data });

export function fail(code: string, message: string, fieldErrors?: Record<string, string[]>): ActionResult<never> {
  return { ok: false, error: { code, message, ...(fieldErrors ? { fieldErrors } : {}) } };
}

/** Convierte cualquier error en ActionResult sin filtrar detalles internos al cliente. */
/**
 * redirect(), notFound() y el uso dinámico de Next se implementan como excepciones con un `digest`
 * reconocible: deben propagarse, nunca convertirse en "error interno". (Equivale a unstable_rethrow,
 * sin importar next/navigation, que no carga fuera de Next: scripts y workers usan este módulo.)
 */
const NEXT_CONTROL_DIGEST = /^(NEXT_REDIRECT|NEXT_HTTP_ERROR_FALLBACK|NEXT_NOT_FOUND|DYNAMIC_SERVER_USAGE|BAILOUT_TO_CLIENT_SIDE_RENDERING|NEXT_PRERENDER_INTERRUPTED)/;
function isNextControlError(err: unknown): boolean {
  const digest = (err as { digest?: unknown } | null)?.digest;
  return typeof digest === "string" && NEXT_CONTROL_DIGEST.test(digest);
}

export function toActionError(err: unknown): ActionResult<never> {
  if (isNextControlError(err)) throw err;
  if (err instanceof DomainError) return fail(err.code, err.message);
  if (err instanceof z.ZodError) {
    return fail("VALIDATION", "Datos inválidos", z.flattenError(err).fieldErrors as Record<string, string[]>);
  }
  console.error("[action] error no controlado", err);
  return fail("INTERNAL", "Ocurrió un error inesperado. Intente nuevamente.");
}
