"use client";

import { useState, useTransition } from "react";
import { saveEstablishmentCodeAction, saveProductCodeAction } from "./actions";

/** Código editable en la misma fila: se guarda al salir del campo. */
export function CodeInput({ kind, id, value, label }: { kind: "branch" | "product"; id: string; value: string | null; label: string }) {
  const [v, setV] = useState(value ?? "");
  const [saved, setSaved] = useState(value ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const save = () => {
    if (v.trim() === saved) return;
    if (kind === "branch" && !v.trim()) return;
    start(async () => {
      const res = kind === "branch" ? await saveEstablishmentCodeAction(id, v) : await saveProductCodeAction(id, v);
      if (res.ok) { setSaved(v.trim()); setError(null); } else setError(res.error.message);
    });
  };
  return (
    <>
      <input className="digemid-input" aria-label={label} aria-invalid={!!error} value={v} disabled={pending} onChange={(e) => setV(e.target.value)} onBlur={save} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); save(); } }} />
      {error && <span className="app-sub" role="alert" style={{ color: "#b42318" }}>{error}</span>}
    </>
  );
}
