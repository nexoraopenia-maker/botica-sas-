"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { reactivateTenantAction, suspendTenantAction } from "@/app/superadmin/actions";
import { useReauth } from "@/app/superadmin/_components/use-reauth";

/** Suspender / reactivar con motivo obligatorio (≥ 15 caracteres) y reautenticación MFA. */
export function StatusButton({ tenantId, name, status }: { tenantId: string; name: string; status: string }) {
  const router = useRouter();
  const { run, dialog } = useReauth();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const suspending = status === "TRIAL" || status === "ACTIVE";
  if (!suspending && status !== "SUSPENDED") return null;

  const confirm = () =>
    startTransition(async () => {
      setError(null);
      const res = await run(() =>
        suspending ? suspendTenantAction({ tenantId, reason }) : reactivateTenantAction(tenantId, reason),
      );
      if (!res.ok) {
        setError(res.error.fieldErrors?.reason?.[0] ?? res.error.message);
        return;
      }
      setOpen(false);
      setReason("");
      router.refresh();
    });

  return (
    <>
      {dialog}
      <button type="button" className={`btn small${suspending ? " danger" : ""}`} onClick={() => setOpen(true)}>
        {suspending ? "Suspender" : "Reactivar"}
      </button>
      {open && (
        <div className="overlay" role="dialog" aria-modal="true" aria-labelledby={`st-${tenantId}`}>
          <div className="dialog">
            <h2 id={`st-${tenantId}`}>{suspending ? "Suspender" : "Reactivar"} a {name}</h2>
            <p className="muted">
              {suspending
                ? "Los usuarios del negocio perderán acceso y los envíos a SUNAT quedarán en pausa. Los datos se conservan."
                : "Los usuarios recuperan el acceso y se reanudan los envíos pendientes a SUNAT."}
            </p>
            <textarea
              rows={3} value={reason} autoFocus aria-label="Motivo"
              placeholder="Motivo (mínimo 15 caracteres; queda en la auditoría del cliente)"
              onChange={(e) => setReason(e.target.value)}
            />
            {error && <p className="error" role="alert">{error}</p>}
            <div className="actions">
              <button type="button" className="btn" onClick={() => setOpen(false)} disabled={pending}>Cancelar</button>
              <button
                type="button" className={`btn ${suspending ? "danger" : "primary"}`}
                onClick={confirm} disabled={pending || reason.trim().length < 15}
              >
                {pending ? "Procesando…" : suspending ? "Suspender" : "Reactivar"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
