import { redirect } from "next/navigation";
import { supabaseAdmin, supabaseServer } from "@/lib/supabase/server";
import { confirmEnrollmentAction } from "../../actions";

/**
 * Enrolamiento TOTP (primer ingreso). Si ya hay un factor verificado, se va a la verificación.
 * Factores pendientes de visitas anteriores se descartan para generar un QR nuevo.
 * La limpieza usa el Admin API: mfa.listFactors() de la sesión no devuelve factores sin verificar.
 * Cada enrolamiento lleva un nombre único: si el navegador pide la página dos veces casi a la vez,
 * ambas renderizaciones enrolan sin chocar por friendly_name (el sobrante se limpia en la próxima visita).
 */
export default async function EnrollMfaPage({ searchParams }: { searchParams: Promise<{ next?: string; error?: string }> }) {
  const { next, error } = await searchParams;
  const target = next ?? "/app";
  const supabase = await supabaseServer();
  const { data: claims } = await supabase.auth.getClaims();
  if (!claims?.claims) redirect(`/login?next=${encodeURIComponent(target)}`);

  const userId = claims.claims.sub;
  const admin = supabaseAdmin().auth.admin.mfa;
  const { data: listed } = await admin.listFactors({ userId });
  const factors = listed?.factors ?? [];
  if (factors.some((f) => f.factor_type === "totp" && f.status === "verified")) {
    redirect(`/login/mfa?next=${encodeURIComponent(target)}`);
  }
  const staleBefore = Date.now() - 10_000; // no borrar el factor que otra renderización acaba de crear
  for (const f of factors) {
    if (f.status !== "verified" && new Date(f.created_at).getTime() < staleBefore) {
      await admin.deleteFactor({ id: f.id, userId });
    }
  }

  const { data, error: enrollError } = await supabase.auth.mfa.enroll({
    factorType: "totp",
    friendlyName: `Nexo ERP ${new Date().toISOString()}`,
  });
  if (enrollError || !data) {
    return (
      <main style={{ maxWidth: 420, margin: "10vh auto" }}>
        <h1>Verificación en dos pasos</h1>
        <p role="alert" className="tag bad">No se pudo iniciar el enrolamiento: {enrollError?.message ?? "error desconocido"}</p>
      </main>
    );
  }

  return (
    <main style={{ maxWidth: 420, margin: "6vh auto" }}>
      <h1>Active la verificación en dos pasos</h1>
      <ol>
        <li>Escanee el código con Google Authenticator, Microsoft Authenticator, 1Password u otra app TOTP.</li>
        <li>Ingrese el código de 6 dígitos que muestra la app.</li>
      </ol>
      {/* eslint-disable-next-line @next/next/no-img-element -- data URI SVG generado por Supabase */}
      <img src={data.totp.qr_code} alt="Código QR para la app autenticadora" width={200} height={200} style={{ background: "#fff" }} />
      <p>¿No puede escanear? Ingrese esta clave manualmente:<br /><code style={{ wordBreak: "break-all" }}>{data.totp.secret}</code></p>
      {error && <p role="alert" className="tag bad">Código incorrecto. Se generó un QR nuevo: vuelva a escanearlo.</p>}
      <form action={confirmEnrollmentAction}>
        <input type="hidden" name="factorId" value={data.id} />
        <input type="hidden" name="next" value={target} />
        <p><input name="code" inputMode="numeric" pattern="\d{6}" maxLength={6} required autoComplete="one-time-code" aria-label="Código de 6 dígitos" /></p>
        <button type="submit">Activar y continuar</button>
      </form>
    </main>
  );
}
