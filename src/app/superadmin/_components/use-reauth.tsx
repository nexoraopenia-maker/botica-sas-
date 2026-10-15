"use client";

import { useRef, useState, type ReactNode } from "react";
import { reauthAction } from "@/app/superadmin/actions";
import type { ActionResult } from "@/lib/result";

/**
 * Envuelve una Server Action crítica: si el servidor responde REAUTH_REQUIRED,
 * pide el código TOTP, reautentica y reintenta la acción una vez.
 */
export function useReauth(): {
  run: <T>(fn: () => Promise<ActionResult<T>>) => Promise<ActionResult<T>>;
  dialog: ReactNode;
} {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const resolver = useRef<((ok: boolean) => void) | null>(null);

  const askCode = () =>
    new Promise<boolean>((resolve) => {
      resolver.current = resolve;
      setCode("");
      setError(null);
      setOpen(true);
    });

  const close = (ok: boolean) => {
    setOpen(false);
    resolver.current?.(ok);
    resolver.current = null;
  };

  async function run<T>(fn: () => Promise<ActionResult<T>>): Promise<ActionResult<T>> {
    const first = await fn();
    if (first.ok || first.error.code !== "REAUTH_REQUIRED") return first;
    if (!(await askCode())) return first;
    return fn();
  }

  const submit = async () => {
    setBusy(true);
    const res = await reauthAction(code);
    setBusy(false);
    if (res.ok) close(true);
    else setError(res.error.message);
  };

  const dialog = open ? (
    <div className="overlay" role="dialog" aria-modal="true" aria-labelledby="reauth-title">
      <div className="dialog">
        <h2 id="reauth-title">Confirme su identidad</h2>
        <p className="muted">Esta acción es crítica. Ingrese el código de su app autenticadora.</p>
        <input
          autoFocus inputMode="numeric" pattern="\d{6}" maxLength={6} value={code} aria-label="Código de 6 dígitos"
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
          onKeyDown={(e) => e.key === "Enter" && code.length === 6 && void submit()}
        />
        {error && <p className="error" role="alert">{error}</p>}
        <div className="actions">
          <button type="button" className="btn" onClick={() => close(false)} disabled={busy}>Cancelar</button>
          <button type="button" className="btn primary" onClick={() => void submit()} disabled={busy || code.length !== 6}>
            {busy ? "Verificando…" : "Confirmar"}
          </button>
        </div>
      </div>
    </div>
  ) : null;

  return { run, dialog };
}
