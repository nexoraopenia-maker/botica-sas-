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
export function toActionError(err: unknown): ActionResult<never> {
  if (err instanceof DomainError) return fail(err.code, err.message);
  if (err instanceof z.ZodError) {
    return fail("VALIDATION", "Datos inválidos", z.flattenError(err).fieldErrors as Record<string, string[]>);
  }
  console.error("[action] error no controlado", err);
  return fail("INTERNAL", "Ocurrió un error inesperado. Intente nuevamente.");
}
