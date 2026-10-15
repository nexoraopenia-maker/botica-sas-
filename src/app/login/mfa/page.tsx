import { redirect } from "next/navigation";
import { supabaseServer } from "@/lib/supabase/server";
import { verifyMfaAction } from "../actions";

export default async function MfaPage({ searchParams }: { searchParams: Promise<{ next?: string; error?: string }> }) {
  const { next, error } = await searchParams;
  const supabase = await supabaseServer();
  const { data: factors } = await supabase.auth.mfa.listFactors();
  if (!factors?.totp.some((f) => f.status === "verified")) {
    redirect(`/login/mfa/enroll?next=${encodeURIComponent(next ?? "/app")}`);
  }
  return (
    <main style={{ maxWidth: 360, margin: "10vh auto" }}>
      <h1>Verificación en dos pasos</h1>
      <p>Ingrese el código de 6 dígitos de su app autenticadora.</p>
      {error && <p role="alert" className="tag bad">Código inválido.</p>}
      <form action={verifyMfaAction}>
        <input type="hidden" name="next" value={next ?? "/app"} />
        <p><input name="code" inputMode="numeric" pattern="\d{6}" maxLength={6} required autoComplete="one-time-code" /></p>
        <button type="submit">Verificar</button>
      </form>
    </main>
  );
}
