/**
 * Clasifica el error de Supabase Auth al iniciar sesión. Solo "invalid_credentials" significa
 * correo/contraseña incorrectos; todo lo demás (red, URL o llave mal configuradas, límites) se
 * informa como tal para no ocultar problemas de despliegue detrás de un mensaje engañoso.
 */
export type LoginErrorKind = "credentials" | "unconfirmed" | "rate_limited" | "auth_unavailable";

export interface AuthErrorLike {
  code?: string | undefined;
  status?: number | undefined;
  name?: string | undefined;
  message?: string | undefined;
}

export function classifyLoginError(err: AuthErrorLike): LoginErrorKind {
  if (err.code === "invalid_credentials") return "credentials";
  // Versiones antiguas de GoTrue no envían code: 400 + "Invalid login credentials"
  if (!err.code && err.status === 400 && /invalid login credentials/i.test(err.message ?? "")) return "credentials";
  if (err.code === "email_not_confirmed" || err.code === "provider_email_needs_verification") return "unconfirmed";
  if (err.status === 429 || err.code === "over_request_rate_limit") return "rate_limited";
  // Red caída/URL inválida (status 0, AuthRetryableFetchError), llave inválida (401 "Invalid API key"), 5xx…
  return "auth_unavailable";
}

/** Valor pegado con comillas alrededor (p. ej. "https://…" copiado tal cual desde un archivo .env). */
export const hasWrappingQuotes = (v: string | undefined): boolean => !!v && /^\s*(["']).*\1\s*$/s.test(v);
