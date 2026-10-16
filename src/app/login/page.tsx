import type { Metadata } from "next";
import Image from "next/image";
import { redirect } from "next/navigation";
import { getIdentity, getTenantContext } from "@/lib/auth/session";
import { platformDb } from "@/lib/db";
import { supabaseServer } from "@/lib/supabase/server";
import { Inter } from "next/font/google";
import { loginAction } from "./actions";
import { SubmitButton } from "./submit-button";

const inter = Inter({ subsets: ["latin"], display: "swap" });

export const metadata: Metadata = { title: "Ingresar · AIMA Automatizaciones" };

const ERRORS: Record<string, string> = {
  credentials: "Correo o contraseña incorrectos.",
  invalid: "Revise el correo y la contraseña (mínimo 8 caracteres).",
  unconfirmed: "Su correo aún no está confirmado. Revise la invitación que le enviamos.",
  rate_limited: "Demasiados intentos. Espere un minuto e intente nuevamente.",
  auth_unavailable: "No se pudo conectar con el servicio de autenticación. Su contraseña no fue rechazada: es un problema de conexión o configuración del servidor. Intente nuevamente o avise al administrador.",
  config: "El servidor no está bien configurado (variables de entorno). Avise al administrador de la plataforma.",
  no_tenant: "Su usuario no tiene acceso a ningún negocio activo. Contacte al administrador.",
};

/**
 * Si ya hay sesión válida, /login no muestra el formulario: redirige al panel que corresponde.
 * Así el botón "Atrás" (que vuelve a /login tras ingresar) no aparenta haber cerrado la sesión.
 * Con ?error no se redirige, para no crear bucles (p. ej. usuario sin negocio asignado).
 */
async function redirectIfAuthenticated(next: string | undefined): Promise<void> {
  const identity = await getIdentity();
  if (!identity) return;
  const target = next && next.startsWith("/") && !next.startsWith("//") ? next : "/app";
  const supabase = await supabaseServer();
  const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (aal && aal.nextLevel === "aal2" && aal.currentLevel !== "aal2") redirect(`/login/mfa?next=${encodeURIComponent(target)}`);
  const isAdmin = await platformDb().platformAdmin.findFirst({ where: { id: identity.userId, deleted_at: null }, select: { id: true } });
  if (isAdmin) redirect(target.startsWith("/superadmin") ? target : "/superadmin");
  if (await getTenantContext()) redirect(target.startsWith("/superadmin") ? "/app" : target);
}

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string; error?: string }> }) {
  const { next, error } = await searchParams;
  if (!error) await redirectIfAuthenticated(next);

  return (
    <div className={`auth-screen ${inter.className}`}>
      {/* Fondo: foto difuminada + overlay oscuro con el azul de la marca */}
      <Image src="/brand/login-bg.jpg" alt="" fill priority sizes="100vw" className="auth-bg" />
      <div className="auth-overlay" aria-hidden />

      <main className="auth-main">
        <section className="auth-card" aria-labelledby="login-title">
          <header className="auth-brand">
            <Image
              src="/brand/aima-logo.png" alt="AIMA Automatizaciones" width={1197} height={361} priority
              className="auth-logo"
            />
            <p className="auth-slogan">Tecnología y Automatización Inteligente para Boticas y Veterinarias</p>
            <p className="auth-tagline">Todo tu negocio en un solo sistema</p>
          </header>

          <div className="auth-divider" aria-hidden />

          <h1 id="login-title" className="auth-title">Iniciar sesión</h1>

          {error && (
            <p role="alert" className="auth-error">{ERRORS[error] ?? "No se pudo iniciar sesión."}</p>
          )}

          <form action={loginAction} className="auth-form">
            <input type="hidden" name="next" value={next ?? "/app"} />
            <label className="auth-field">
              <span>Correo electrónico</span>
              <input name="email" type="email" required autoComplete="email" placeholder="usted@empresa.pe" />
            </label>
            <label className="auth-field">
              <span>Contraseña</span>
              <input name="password" type="password" required minLength={8} autoComplete="current-password" placeholder="••••••••" />
            </label>
            <SubmitButton pendingLabel="Ingresando…">Ingresar</SubmitButton>
          </form>

          <p className="auth-secure">Acceso protegido con verificación en dos pasos</p>
        </section>
      </main>

      <footer className="auth-footer">
        <span>© {new Date().getFullYear()} AIMA Automatizaciones</span>
        <span>
          Foto:{" "}
          <a href="https://commons.wikimedia.org/wiki/File:The_interior_of_a_modern_pharmacy_shop_in_the_United_States.jpg" target="_blank" rel="noreferrer">
            Harrison Keely
          </a>
          ,{" "}
          <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noreferrer">CC BY 4.0</a>
          {" "}(desenfocada)
        </span>
      </footer>
    </div>
  );
}
