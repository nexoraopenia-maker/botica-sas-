import "server-only";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";
import { env } from "@/lib/env";
import { DomainError } from "@/lib/result";
import { supabaseAdmin, supabaseServer } from "@/lib/supabase/server";
import { classifyLoginError } from "@/lib/auth/login-errors";

/** Política mínima: 10+ caracteres, con letras y números. */
export const newPasswordSchema = z
  .string()
  .min(10, "La nueva contraseña debe tener al menos 10 caracteres")
  .max(72, "Máximo 72 caracteres")
  .refine((p) => /[A-Za-z]/.test(p) && /\d/.test(p), "Use letras y números");

export const changePasswordSchema = z
  .object({ currentPassword: z.string().min(1, "Ingrese su contraseña actual"), newPassword: newPasswordSchema })
  .refine((v) => v.currentPassword !== v.newPassword, { message: "La nueva contraseña debe ser distinta de la actual", path: ["newPassword"] });

/**
 * Cambio de contraseña del propio usuario.
 *  1. Verifica la contraseña actual con un cliente aislado (sin cookies: no altera la sesión del navegador).
 *  2. Actualiza con updateUser sobre la sesión del usuario. Si el proyecto exige reautenticación
 *     ("Secure password change"), usa la API de administración: la identidad ya se verificó en el paso 1.
 *  3. Cierra las demás sesiones del usuario (otros dispositivos).
 */
export async function changeOwnPassword(input: z.input<typeof changePasswordSchema>): Promise<void> {
  const { currentPassword, newPassword } = changePasswordSchema.parse(input);
  const supabase = await supabaseServer();
  const { data: claims } = await supabase.auth.getClaims();
  const userId = claims?.claims?.sub;
  const email = typeof claims?.claims?.email === "string" ? claims.claims.email : null;
  if (!userId || !email) throw new DomainError("UNAUTHENTICATED", "Su sesión expiró. Inicie sesión nuevamente.");

  const verifier = createClient(env().NEXT_PUBLIC_SUPABASE_URL, env().NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error: verifyError } = await verifier.auth.signInWithPassword({ email, password: currentPassword });
  if (verifyError) {
    const kind = classifyLoginError(verifyError);
    if (kind === "credentials") throw new DomainError("WRONG_PASSWORD", "La contraseña actual no es correcta.");
    if (kind === "rate_limited") throw new DomainError("RATE_LIMITED", "Demasiados intentos. Espere un minuto.");
    console.error("[password] verificación falló", { code: verifyError.code, status: verifyError.status });
    throw new DomainError("AUTH_UNAVAILABLE", "No se pudo verificar su contraseña. Intente nuevamente.");
  }
  await verifier.auth.signOut({ scope: "local" }); // descartar la sesión temporal de verificación

  const { error } = await supabase.auth.updateUser({ password: newPassword });
  if (error) {
    if (error.code === "reauthentication_needed" || error.code === "reauthentication_not_valid") {
      const { error: adminError } = await supabaseAdmin().auth.admin.updateUserById(userId, { password: newPassword });
      if (adminError) throw new DomainError("UPDATE_FAILED", "No se pudo actualizar la contraseña.");
    } else if (error.code === "weak_password") {
      throw new DomainError("WEAK_PASSWORD", "Supabase rechazó la contraseña por débil: use una más larga y variada.");
    } else if (error.code === "same_password") {
      throw new DomainError("SAME_PASSWORD", "La nueva contraseña debe ser distinta de la actual.");
    } else {
      console.error("[password] updateUser falló", { code: error.code, status: error.status });
      throw new DomainError("UPDATE_FAILED", "No se pudo actualizar la contraseña. Intente nuevamente.");
    }
  }
  await supabase.auth.signOut({ scope: "others" }).catch(() => undefined);
}
