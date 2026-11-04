"use client";

import { useState, useTransition } from "react";
import { saveCommissionRateAction } from "./actions";

/** % de comisión editable; solo afecta a las ventas que se hagan desde ahora. */
export function RateInput({ userId, name, percent }: { userId: string; name: string; percent: string }) {
  const [v, setV] = useState(percent);
  const [saved, setSaved] = useState(percent);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const save = () => {
    if (v === saved) return;
    start(async () => {
      const res = await saveCommissionRateAction({ userId, percent: v });
      if (res.ok) { setSaved(v); setError(null); } else setError(res.error.fieldErrors ? Object.values(res.error.fieldErrors).flat()[0] ?? res.error.message : res.error.message);
    });
  };
  return (
    <>
      <input className="digemid-input" inputMode="decimal" aria-label={`Comisión de ${name} en porcentaje`} aria-invalid={!!error} disabled={pending} value={v} onChange={(e) => setV(e.target.value)} onBlur={save} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); save(); } }} /> %
      {error && <span className="app-sub" role="alert" style={{ color: "#b42318" }}>{error}</span>}
    </>
  );
}
