import type { Metadata } from "next";
import Image from "next/image";
import { Inter } from "next/font/google";
import { loginAction } from "./actions";
import { SubmitButton } from "./submit-button";

const inter = Inter({ subsets: ["latin"], display: "swap" });

export const metadata: Metadata = { title: "Ingresar · AIMA Automatizaciones" };

const ERRORS: Record<string, string> = {
  credentials: "Correo o contraseña incorrectos.",
  invalid: "Revise el correo y la contraseña (mínimo 8 caracteres).",
  no_tenant: "Su usuario no tiene acceso a ningún negocio activo. Contacte al administrador.",
};

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string; error?: string }> }) {
  const { next, error } = await searchParams;

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
