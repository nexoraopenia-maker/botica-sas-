import { loginAction } from "./actions";

const ERRORS: Record<string, string> = {
  credentials: "Correo o contraseña incorrectos.",
  invalid: "Revise el correo y la contraseña (mínimo 8 caracteres).",
  no_tenant: "Su usuario no tiene acceso a ningún negocio activo. Contacte al administrador.",
};

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string; error?: string }> }) {
  const { next, error } = await searchParams;
  return (
    <main style={{ maxWidth: 360, margin: "10vh auto" }}>
      <h1>Ingresar</h1>
      {error && <p role="alert" className="alert">{ERRORS[error] ?? "No se pudo iniciar sesión."}</p>}
      <form action={loginAction}>
        <input type="hidden" name="next" value={next ?? "/app"} />
        <p><label>Correo<br /><input name="email" type="email" required autoComplete="email" /></label></p>
        <p><label>Contraseña<br /><input name="password" type="password" required minLength={8} autoComplete="current-password" /></label></p>
        <button type="submit">Ingresar</button>
      </form>
    </main>
  );
}
