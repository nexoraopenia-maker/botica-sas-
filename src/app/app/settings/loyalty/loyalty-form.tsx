"use client";

import { useState, useTransition } from "react";
import { saveLoyaltyAction } from "./actions";

export function LoyaltyForm({ enabled: initial, percent: initialPercent }: { enabled: boolean; percent: string }) {
  const [enabled, setEnabled] = useState(initial);
  const [percent, setPercent] = useState(initialPercent);
  const [msg, setMsg] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const [pending, start] = useTransition();
  function submit(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    start(async () => {
      const res = await saveLoyaltyAction({ enabled, earnPercent: percent });
      setMsg(res.ok ? { tone: "ok", text: "Configuración guardada." } : { tone: "bad", text: res.error.fieldErrors ? Object.values(res.error.fieldErrors).flat()[0] ?? res.error.message : res.error.message });
    });
  }
  return (
    <form onSubmit={submit} className="set-form">
      <label className="set-check wide"><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Activar el monedero virtual</label>
      <label className="set-field"><span>% de cada compra que se acumula</span><input inputMode="decimal" value={percent} onChange={(e) => setPercent(e.target.value)} /><small>Solo clientes con DNI o RUC y ventas al contado. Lo pagado con monedero no genera saldo.</small></label>
      <p className="app-muted wide" style={{ margin: 0 }}>Consulte con su contador cómo registrar el saldo a favor: en el comprobante figura como un medio de pago y el total no cambia.</p>
      {msg && <p className={`set-msg ${msg.tone} wide`} role={msg.tone === "bad" ? "alert" : "status"}>{msg.text}</p>}
      <div className="wide rx-actions"><button type="submit" className="app-btn primary" disabled={pending}>{pending ? "Guardando…" : "Guardar"}</button></div>
    </form>
  );
}
