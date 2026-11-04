"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { cashSummaryAction, closeCashAction } from "@/app/app/pos/actions";
import type { CashSummary } from "@/lib/pos/cash-closure";

const METHODS = [
  { key: "EFECTIVO", label: "Efectivo" }, { key: "YAPE", label: "Yape" }, { key: "PLIN", label: "Plin" }, { key: "TARJETA", label: "Tarjetas" },
] as const;
type Method = (typeof METHODS)[number]["key"];
const OTHER: Record<string, string> = { TRANSFERENCIA: "Transferencia", CREDITO: "Crédito", MONEDERO: "Monedero" };

const num = (v: string) => Number(v.replace(",", ".")) || 0;
const money = (n: number) => `S/ ${n.toLocaleString("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const time = (iso: string) => new Date(iso).toLocaleString("es-PE", { timeZone: "America/Lima", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

/** Arqueo obligatorio por medio de pago: esperado (servidor) contra contado, con descuadre por línea y total. */
export function CashClosureModal({ branchId, onClose }: { branchId: string; onClose: () => void }) {
  const [summary, setSummary] = useState<CashSummary | null>(null);
  const [opening, setOpening] = useState("0");
  const [counted, setCounted] = useState<Record<Method, string>>({ EFECTIVO: "", YAPE: "", PLIN: "", TARJETA: "" });
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ difference: string } | null>(null);
  const [pending, start] = useTransition();
  const key = useRef<string>(crypto.randomUUID());

  useEffect(() => {
    void cashSummaryAction(branchId).then((r) => (r.ok ? setSummary(r.data) : setError(r.error.message)));
  }, [branchId]);

  const refunded = (m: Method) => num(summary?.refunds[m] ?? "0");
  const expected = (m: Method) => num(summary?.sales[m] ?? "0") - refunded(m) + (m === "EFECTIVO" ? num(opening) : 0);
  const refundList = METHODS.filter((m) => refunded(m.key) > 0);
  const diff = (m: Method) => num(counted[m]) - expected(m);
  const totalDiff = Math.round(METHODS.reduce((a, m) => a + diff(m.key), 0) * 100) / 100;
  const complete = METHODS.every((m) => counted[m.key].trim() !== "");

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!complete) return setError("Ingrese lo contado en los cuatro medios de pago (0 si no hubo).");
    if (totalDiff !== 0 && !notes.trim()) return setError("Hay un descuadre: explique el motivo en las observaciones.");
    start(async () => {
      const res = await closeCashAction({ idempotencyKey: key.current, branchId, opening, counted, notes: notes.trim() || undefined });
      if (res.ok) setDone({ difference: res.data.difference });
      else setError(res.error.fieldErrors ? Object.values(res.error.fieldErrors).flat()[0] ?? res.error.message : res.error.message);
    });
  }

  return (
    <div className="pos-overlay" role="dialog" aria-modal="true" aria-labelledby="closure-title">
      <div className="pos-modal">
        <h2 id="closure-title">Cierre de caja</h2>
        {done ? (
          <>
            <p className={`set-msg ${Number(done.difference) === 0 ? "ok" : "bad"}`} role="status">
              Cierre registrado{Number(done.difference) === 0 ? " sin descuadre." : ` con un descuadre de ${money(Number(done.difference))}.`}
            </p>
            <div className="rx-actions" style={{ marginTop: 16 }}><button type="button" className="app-btn primary" onClick={onClose} autoFocus>Listo</button></div>
          </>
        ) : !summary ? (
          error ? <><p className="set-msg bad" role="alert">{error}</p><div className="rx-actions" style={{ marginTop: 16 }}><button type="button" className="app-btn" onClick={onClose}>Cerrar</button></div></> : <p className="app-muted">Calculando ventas del turno…</p>
        ) : (
          <form onSubmit={submit}>
            <p className="app-muted">Turno desde {time(summary.from)} · {summary.documents} comprobante{summary.documents === 1 ? "" : "s"}</p>
            <label className="set-field closure-opening"><span>Fondo inicial en efectivo</span>
              <input inputMode="decimal" value={opening} onChange={(e) => setOpening(e.target.value)} /></label>
            <div className="app-table-wrap"><table className="app-table closure-table">
              <thead><tr><th>Medio</th><th className="num">Esperado</th><th className="num">Contado *</th><th className="num">Diferencia</th></tr></thead>
              <tbody>{METHODS.map((m) => (
                <tr key={m.key}>
                  <td>{m.label}</td>
                  <td className="num">{money(expected(m.key))}</td>
                  <td className="num"><input inputMode="decimal" required aria-label={`Contado en ${m.label}`} value={counted[m.key]} onChange={(e) => setCounted((c) => ({ ...c, [m.key]: e.target.value }))} /></td>
                  <td className={`num ${counted[m.key] && Math.abs(diff(m.key)) >= 0.005 ? "closure-bad" : ""}`}>{counted[m.key] ? money(diff(m.key)) : "—"}</td>
                </tr>
              ))}</tbody>
              <tfoot><tr><th colSpan={3}>Diferencia / Descuadre</th><th className={`num ${totalDiff !== 0 ? "closure-bad" : ""}`}>{complete ? money(totalDiff) : "—"}</th></tr></tfoot>
            </table></div>
            {refundList.length > 0 && (
              <p className="app-muted">Descontado por notas de crédito: {refundList.map((m) => `${m.label} ${money(refunded(m.key))}`).join(" · ")}</p>
            )}
            {summary.others.length > 0 && (
              <p className="app-muted">No se arquean: {summary.others.map((o) => `${OTHER[o.method] ?? o.method} ${money(Number(o.total))}`).join(" · ")}</p>
            )}
            <label className="set-field" style={{ marginTop: 12 }}><span>Observaciones{complete && totalDiff !== 0 ? " *" : ""}</span>
              <input value={notes} maxLength={500} onChange={(e) => setNotes(e.target.value)} placeholder="Motivo del descuadre, si lo hay" /></label>
            {error && <p className="set-msg bad" role="alert" style={{ marginTop: 12 }}>{error}</p>}
            <div className="rx-actions" style={{ marginTop: 16 }}>
              <button type="button" className="app-btn" onClick={onClose}>Cancelar</button>
              <button type="submit" className="app-btn primary" disabled={pending}>{pending ? "Registrando…" : "Registrar cierre"}</button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
