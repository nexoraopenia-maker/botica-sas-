"use client";

import { useState, useTransition } from "react";
import { createPortal } from "react-dom";
import { changePasswordAction } from "./actions";
import { Icon } from "@/app/app/_components/icons";

/** Botón del menú de perfil + diálogo para cambiar la propia contraseña. */
export function ChangePasswordButton() {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [show, setShow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [pending, start] = useTransition();

  const reset = () => { setCurrent(""); setNext(""); setConfirm(""); setError(null); setDone(false); setShow(false); };
  const close = () => { setOpen(false); reset(); };
  const strong = next.length >= 10 && /[A-Za-z]/.test(next) && /\d/.test(next);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!strong) return setError("La nueva contraseña debe tener al menos 10 caracteres, con letras y números.");
    if (next !== confirm) return setError("La confirmación no coincide con la nueva contraseña.");
    start(async () => {
      const res = await changePasswordAction({ currentPassword: current, newPassword: next });
      if (!res.ok) return setError(res.error.fieldErrors ? Object.values(res.error.fieldErrors).flat()[0] ?? res.error.message : res.error.message);
      setDone(true);
      setCurrent(""); setNext(""); setConfirm("");
    });
  };

  return (
    <>
      <button type="button" className="app-user-item neutral" onClick={(e) => { (e.currentTarget.closest("details") as HTMLDetailsElement | null)?.removeAttribute("open"); setOpen(true); }}>
        <Icon name="shield" size={16} /> Cambiar contraseña
      </button>
      {open && createPortal(
        <div className="overlay pw-overlay" role="dialog" aria-modal="true" aria-labelledby="pw-title" onKeyDown={(e) => e.key === "Escape" && close()}>
          <form className="dialog pw-dialog" onSubmit={submit}>
            <h2 id="pw-title">Cambiar contraseña</h2>
            {done ? (
              <>
                <p className="set-msg ok" role="status">Contraseña actualizada. Por seguridad cerramos sus sesiones en otros dispositivos.</p>
                <div className="actions"><button type="button" className="btn primary" onClick={close} autoFocus>Listo</button></div>
              </>
            ) : (
              <>
                <label className="set-field"><span>Contraseña actual</span>
                  <input type={show ? "text" : "password"} value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" required autoFocus /></label>
                <label className="set-field"><span>Nueva contraseña</span>
                  <input type={show ? "text" : "password"} value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" required minLength={10} />
                  <small className={next && !strong ? "bad" : undefined}>Mínimo 10 caracteres, con letras y números.</small></label>
                <label className="set-field"><span>Confirmar nueva contraseña</span>
                  <input type={show ? "text" : "password"} value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" required />
                  {confirm && confirm !== next && <small className="bad">No coincide.</small>}</label>
                <label className="set-check"><input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} /> Mostrar contraseñas</label>
                {error && <p className="error" role="alert">{error}</p>}
                <div className="actions">
                  <button type="button" className="btn" onClick={close} disabled={pending}>Cancelar</button>
                  <button type="submit" className="btn primary" disabled={pending || !current || !strong || next !== confirm}>{pending ? "Guardando…" : "Cambiar contraseña"}</button>
                </div>
              </>
            )}
          </form>
        </div>,
        document.body,
      )}
    </>
  );
}
