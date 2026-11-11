"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { registerWasteAction } from "./actions";

type Reason = "EXPIRED" | "DAMAGED" | "RECALL" | "OTHER";
const REASONS: { key: Reason; label: string }[] = [
  { key: "EXPIRED", label: "Vencido" },
  { key: "DAMAGED", label: "Dañado o roto" },
  { key: "RECALL", label: "Retiro del mercado (alerta DIGEMID)" },
  { key: "OTHER", label: "Otro" },
];

export function WasteButton({ batchId, product, lot, stock, expired, controlled }: { batchId: string; product: string; lot: string; stock: string; expired: boolean; controlled: boolean }) {
  const router = useRouter();
  const key = useRef<string>(crypto.randomUUID());
  const [open, setOpen] = useState(false);
  const [quantity, setQuantity] = useState(stock);
  const [reason, setReason] = useState<Reason>(expired ? "EXPIRED" : "DAMAGED");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    start(async () => {
      const res = await registerWasteAction({ idempotencyKey: key.current, batchId, quantity, reason, note });
      if (!res.ok) { setError(res.error.fieldErrors ? Object.values(res.error.fieldErrors).flat()[0] ?? res.error.message : res.error.message); return; }
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <>
      <button type="button" className="app-btn" onClick={() => { key.current = crypto.randomUUID(); setQuantity(stock); setNote(""); setError(null); setOpen(true); }}>Registrar merma</button>
      {open && (
        <div className="pos-overlay" role="dialog" aria-modal="true" aria-labelledby={`waste-${batchId}`}>
          <form className="pos-modal" onSubmit={submit}>
            <h2 id={`waste-${batchId}`}>Registrar merma</h2>
            <p className="app-muted">{product} · lote {lot} · stock {stock}</p>
            {controlled && <p className="set-msg warn" style={{ marginBottom: 12 }}>Producto controlado: la salida también queda en el libro de controlados.</p>}
            <div className="set-form">
              <label className="set-field"><span>Cantidad a dar de baja *</span>
                <input inputMode="decimal" value={quantity} onChange={(e) => setQuantity(e.target.value)} required autoFocus /></label>
              <label className="set-field"><span>Motivo *</span>
                <select value={reason} onChange={(e) => setReason(e.target.value as Reason)}>
                  {REASONS.map((r) => <option key={r.key} value={r.key} disabled={r.key === "EXPIRED" && !expired}>{r.label}{r.key === "EXPIRED" && !expired ? " (el lote aún no vence)" : ""}</option>)}
                </select></label>
              <label className="set-field wide"><span>Detalle (queda en la auditoría) *</span>
                <input value={note} maxLength={250} minLength={5} required placeholder="Ej.: lote vencido retirado de exhibición" onChange={(e) => setNote(e.target.value)} /></label>
              {error && <p className="set-msg bad wide" role="alert">{error}</p>}
            </div>
            <p className="app-muted" style={{ marginTop: 12 }}>La baja no se puede deshacer: queda en el kardex y en la auditoría con su nombre.</p>
            <div className="rx-actions" style={{ marginTop: 12 }}>
              <button type="button" className="app-btn" disabled={pending} onClick={() => setOpen(false)}>Cancelar</button>
              <button type="submit" className="app-btn primary" disabled={pending}>{pending ? "Registrando…" : "Dar de baja"}</button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}
