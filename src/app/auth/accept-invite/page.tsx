"use client";

import { useEffect, useMemo, useState } from "react";
import { createBrowserClient } from "@supabase/ssr";
import { acceptInviteAction } from "./actions";

/**
 * Destino del enlace de invitación de Supabase. Los tokens llegan en el fragmento (#access_token=…),
 * que el servidor no ve: se establece la sesión en el navegador (cookies) y se pide la contraseña.
 */
export default function AcceptInvitePage() {
  const supabase = useMemo(
    () => createBrowserClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!),
    [],
  );
  const [state, setState] = useState<"loading" | "ready" | "invalid">("loading");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.hash.slice(1));
    const access_token = params.get("access_token");
    const refresh_token = params.get("refresh_token");
    const init = async () => {
      if (access_token && refresh_token) {
        const { error: e } = await supabase.auth.setSession({ access_token, refresh_token });
        window.history.replaceState(null, "", window.location.pathname); // no dejar tokens en la URL
        setState(e ? "invalid" : "ready");
        return;
      }
      const { data } = await supabase.auth.getSession();
      setState(data.session ? "ready" : "invalid");
    };
    void init();
  }, [supabase]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (password.length < 10) return setError("La contraseña debe tener al menos 10 caracteres.");
    if (password !== confirm) return setError("Las contraseñas no coinciden.");
    setBusy(true);
    const { error: upd } = await supabase.auth.updateUser({ password });
    if (upd) {
      setBusy(false);
      return setError(upd.message);
    }
    const res = await acceptInviteAction();
    setBusy(false);
    if (!res.ok) return setError(res.error.message);
    window.location.assign("/app");
  };

  return (
    <main style={{ maxWidth: 380, margin: "10vh auto" }}>
      <h1>Bienvenido a Nexo ERP</h1>
      {state === "loading" && <p className="muted">Validando invitación…</p>}
      {state === "invalid" && (
        <p className="alert" role="alert">El enlace de invitación no es válido o expiró. Pida al administrador de la plataforma que lo reenvíe.</p>
      )}
      {state === "ready" && (
        <form onSubmit={submit}>
          <p>Cree su contraseña para ingresar.</p>
          <p className="field"><label>Contraseña<br /><input type="password" value={password} minLength={10} required autoComplete="new-password" onChange={(e) => setPassword(e.target.value)} /></label></p>
          <p className="field"><label>Repita la contraseña<br /><input type="password" value={confirm} required autoComplete="new-password" onChange={(e) => setConfirm(e.target.value)} /></label></p>
          {error && <p className="error" role="alert">{error}</p>}
          <button type="submit" className="btn primary" disabled={busy}>{busy ? "Guardando…" : "Crear contraseña e ingresar"}</button>
        </form>
      )}
    </main>
  );
}
