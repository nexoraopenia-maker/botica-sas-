"use client";

import { useState, useTransition } from "react";
import { startImpersonationAction } from "@/app/superadmin/actions";
import { useReauth } from "@/app/superadmin/_components/use-reauth";
import { Icon } from "@/app/app/_components/icons";

/**
 * Soporte técnico: abre una sesión de impersonación auditada (motivo obligatorio, TTL ≤ 60 min,
 * solo lectura por defecto) y navega al panel /app del cliente.
 */
export function EnterPanelButton({ tenantId, name, canWrite, disabled }: { tenantId: string; name: string; canWrite: boolean; disabled?: boolean }) {
  const { run, dialog } = useReauth();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [ticket, setTicket] = useState("");
  const [minutes, setMinutes] = useState(30);
  const [readOnly, setReadOnly] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const enter = () =>
    start(async () => {
      setError(null);
      const res = await run(() => startImpersonationAction({ tenantId, reason, ticketRef: ticket || undefined, minutes, readOnly }));
      if (!res.ok) return setError(res.error.fieldErrors?.reason?.[0] ?? res.error.message);
      window.location.assign("/app"); // navegación completa: la cookie de soporte ya está fijada
    });

  return (
    <>
      {dialog}
      <button type="button" className="app-btn small support" onClick={() => setOpen(true)} disabled={disabled}
        title={disabled ? "No disponible para clientes eliminados" : `Entrar al panel de ${name} como soporte`}>
        <Icon name="enter" size={15} /> Entrar al panel
      </button>
      {open && (
        <div className="overlay" role="dialog" aria-modal="true" aria-labelledby={`imp-${tenantId}`}>
          <div className="dialog sa-dialog">
            <h2 id={`imp-${tenantId}`}>Entrar al panel de {name}</h2>
            <p className="muted">Verá el sistema como el cliente para darle soporte. La sesión queda registrada en la auditoría del cliente y él puede verla.</p>
            <label className="set-field"><span>Motivo *</span>
              <textarea rows={3} value={reason} autoFocus onChange={(e) => setReason(e.target.value)}
                placeholder="Ej. El cliente reporta que no ve su stock en la sucursal Centro" />
              <small>{reason.trim().length < 15 ? `Mínimo 15 caracteres (${reason.trim().length}/15)` : "Listo"}</small>
            </label>
            <div className="sa-dialog-row">
              <label className="set-field"><span>Ticket (opcional)</span><input value={ticket} onChange={(e) => setTicket(e.target.value)} placeholder="SOP-1024" /></label>
              <label className="set-field"><span>Duración</span>
                <select value={minutes} onChange={(e) => setMinutes(Number(e.target.value))}>
                  <option value={15}>15 minutos</option><option value={30}>30 minutos</option><option value={60}>60 minutos</option>
                </select></label>
            </div>
            <label className="set-check">
              <input type="checkbox" checked={!readOnly} disabled={!canWrite} onChange={(e) => setReadOnly(!e.target.checked)} />
              Permitir cambios {canWrite ? "(con escritura)" : "— solo el Propietario de la plataforma"}
            </label>
            {error && <p className="error" role="alert">{error}</p>}
            <div className="actions">
              <button type="button" className="btn" onClick={() => setOpen(false)} disabled={pending}>Cancelar</button>
              <button type="button" className="btn primary" onClick={enter} disabled={pending || reason.trim().length < 15}>
                {pending ? "Abriendo…" : readOnly ? "Entrar en solo lectura" : "Entrar con escritura"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
