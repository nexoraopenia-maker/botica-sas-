"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { issueCreditNoteAction } from "@/app/app/documents/actions";
import type { CreditNoteContext } from "@/lib/sunat/credit-note";

type Reason = "07" | "06" | "01" | "02";
type Refund = "EFECTIVO" | "YAPE" | "PLIN" | "TARJETA" | "TRANSFERENCIA" | "";

const REASONS: { key: Reason; label: string; hint: string; restocks: boolean }[] = [
  { key: "07", label: "Devolución por ítem", hint: "El cliente devuelve parte de lo comprado. El stock vuelve a su lote.", restocks: true },
  { key: "06", label: "Devolución total", hint: "El cliente devuelve todo. El stock vuelve a sus lotes.", restocks: true },
  { key: "01", label: "Anulación de la operación", hint: "La venta se deja sin efecto. El stock vuelve a sus lotes.", restocks: true },
  { key: "02", label: "Anulación por error en el RUC", hint: "El RUC del comprobante era incorrecto: no repone stock. Luego emita la factura correcta.", restocks: false },
];
const REFUNDS: { key: Refund; label: string }[] = [
  { key: "EFECTIVO", label: "Efectivo" }, { key: "YAPE", label: "Yape" }, { key: "PLIN", label: "Plin" }, { key: "TARJETA", label: "Tarjeta" }, { key: "TRANSFERENCIA", label: "Transferencia" },
];

const money = (n: number) => `S/ ${n.toLocaleString("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const num = (v: string) => Number(v.replace(",", ".")) || 0;

export function CreditNoteForm({ data, canAuthorizeControlled }: { data: CreditNoteContext; canAuthorizeControlled: boolean }) {
  const router = useRouter();
  const { document: d, lines } = data;
  const key = useRef<string>(crypto.randomUUID());
  const onCredit = d.paymentTerms === "Credito";
  // Sugerencia: el medio con el que se pagó, si fue uno solo y se puede devolver
  const paid = data.payments.filter((p) => p.method !== "MONEDERO" && p.method !== "CREDITO");
  const suggested = (paid.length === 1 && REFUNDS.some((r) => r.key === paid[0]!.method) ? paid[0]!.method : "") as Refund;
  const walletPaid = data.payments.find((p) => p.method === "MONEDERO");
  const hasPrior = data.priorNotes.length > 0;

  const [reason, setReason] = useState<Reason>("07");
  const [qty, setQty] = useState<Record<string, string>>({});
  const [text, setText] = useState("");
  const [series, setSeries] = useState(data.series[0] ?? "");
  const [refund, setRefund] = useState<Refund>(onCredit ? "" : suggested);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const partial = reason === "07";
  const available = REASONS.filter((r) => (r.key === "02" ? d.docType === "FACTURA" : true) && (r.key === "07" || !hasPrior));
  const meta = REASONS.find((r) => r.key === reason)!;
  const chosen = partial
    ? lines.map((l) => ({ l, q: num(qty[l.id] ?? "") })).filter((x) => x.q > 0)
    : lines.map((l) => ({ l, q: Number(l.sold) }));
  // Los controlados solo los devuelve el químico farmacéutico o el administrador; el servidor lo vuelve a exigir
  const saleHasControlled = lines.some((l) => l.controlled);
  const blockedControlled = chosen.filter((x) => x.l.controlled && !canAuthorizeControlled).map((x) => x.l.description);
  const needsPharmacist = blockedControlled.length > 0;
  // Estimado: el total exacto, con su IGV y redondeo, lo calcula el servidor
  const total = chosen.reduce((a, { l, q }) => a + (Number(l.lineTotal) / Number(l.sold)) * q, 0);

  function validate(): string | null {
    if (needsPharmacist) return "Se requiere al Químico Farmacéutico o Administrador para devolver medicamentos controlados.";
    if (partial && chosen.length === 0) return "Indique la cantidad de al menos un producto.";
    for (const { l, q } of chosen) {
      if (partial && q > Number(l.remaining)) return `${l.description}: solo quedan ${l.remaining} por devolver.`;
      if (partial && !l.fractional && !Number.isInteger(q)) return `${l.description}: la cantidad debe ser entera.`;
    }
    if (text.trim().length < 5) return "Explique el motivo (mínimo 5 caracteres).";
    return null;
  }
  function review(e: React.FormEvent) {
    e.preventDefault();
    const problem = validate();
    setError(problem);
    if (!problem) setConfirming(true);
  }
  function issue() {
    setError(null);
    start(async () => {
      const res = await issueCreditNoteAction({
        idempotencyKey: key.current, documentId: d.id, series, reasonCode: reason, reasonText: text.trim(),
        lines: partial ? chosen.map(({ l, q }) => ({ itemId: l.id, quantity: q })) : [],
        refundMethod: refund || undefined,
      });
      if (!res.ok) {
        setConfirming(false);
        setError(res.error.fieldErrors ? Object.values(res.error.fieldErrors).flat()[0] ?? res.error.message : res.error.message);
        return;
      }
      router.push(`/app/documents?nc=${res.data.series}-${res.data.number}`);
    });
  }

  return (
    <form onSubmit={review}>
      <div className="set-form">
        <fieldset className="set-field wide">
          <legend>Motivo *</legend>
          <div className="nc-reasons">
            {available.map((r) => (
              <label key={r.key} className={`nc-reason${reason === r.key ? " on" : ""}`}>
                <input type="radio" name="reason" checked={reason === r.key} onChange={() => setReason(r.key)} />
                <span><strong>{r.label}</strong><small>{r.hint}</small></span>
              </label>
            ))}
          </div>
        </fieldset>
      </div>

      {saleHasControlled && !canAuthorizeControlled && (
        <p className={`set-msg ${needsPharmacist ? "bad" : "warn"}`} role={needsPharmacist ? "alert" : "status"} style={{ marginBottom: 12 }}>
          {needsPharmacist
            ? `Esta nota incluye medicamentos controlados (${blockedControlled.join(", ")}). Se requiere la autorización y firma del Químico Farmacéutico o del Administrador: pídale que la emita.`
            : "Esta venta incluye medicamentos controlados. Solo el Químico Farmacéutico o el Administrador puede devolverlos; usted puede devolver el resto de los productos."}
        </p>
      )}

      <div className="app-table-wrap"><table className="app-table stack">
        <thead><tr><th>Producto</th><th className="num">Vendido</th><th className="num">Por devolver</th><th className="num">Precio</th><th className="num">{partial ? "Devolver" : "Se acredita"}</th></tr></thead>
        <tbody>{lines.map((l) => (
          <tr key={l.id}>
            <td data-label="Producto"><strong>{l.description}</strong><span className="app-sub">{l.unitLabel}{l.controlled ? " · Controlado" : ""}</span></td>
            <td data-label="Vendido" className="num">{l.sold}</td>
            <td data-label="Por devolver" className="num">{l.remaining}</td>
            <td data-label="Precio" className="num">{money(Number(l.unitPrice))}</td>
            <td data-label={partial ? "Devolver" : "Se acredita"} className="num">
              {partial ? (
                <input className="digemid-input" inputMode={l.fractional ? "decimal" : "numeric"} aria-label={`Cantidad a devolver de ${l.description}`} disabled={Number(l.remaining) <= 0 || (l.controlled && !canAuthorizeControlled)} value={qty[l.id] ?? ""} placeholder="0"
                  onChange={(e) => setQty((p) => ({ ...p, [l.id]: e.target.value }))} />
              ) : l.sold}
            </td>
          </tr>
        ))}</tbody>
      </table></div>

      <div className="set-form">
        <label className="set-field wide"><span>Sustento (va en el comprobante) *</span>
          <input value={text} maxLength={250} required minLength={5} placeholder="Ej.: producto devuelto en buen estado" onChange={(e) => setText(e.target.value)} /></label>
        <label className="set-field"><span>Serie *</span>
          <select value={series} onChange={(e) => setSeries(e.target.value)}>{data.series.map((s) => <option key={s} value={s}>{s}</option>)}</select></label>
        <label className="set-field"><span>Medio de devolución</span>
          <select value={refund} disabled={onCredit} onChange={(e) => setRefund(e.target.value as Refund)}>
            <option value="">Sin devolución de dinero</option>
            {REFUNDS.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
          </select>
          <small>{onCredit ? "La venta fue a crédito: no se devuelve dinero." : "Se descuenta del cierre de caja de quien emite la nota."}</small></label>
        {walletPaid && <p className="app-muted wide" style={{ margin: 0 }}>Esta venta usó S/ {walletPaid.amount} de monedero: esa parte vuelve al monedero y no se devuelve en dinero.</p>}
        {error && <p className="set-msg bad wide" role="alert">{error}</p>}
        <div className="wide nc-total">
          <span>Total estimado de la nota: <strong>{money(total)}</strong></span>
          <button type="submit" className="app-btn primary" disabled={needsPharmacist} title={needsPharmacist ? "Requiere al Químico Farmacéutico o Administrador" : undefined}>Revisar y emitir</button>
        </div>
      </div>

      {confirming && (
        <div className="pos-overlay" role="dialog" aria-modal="true" aria-labelledby="nc-confirm">
          <div className="pos-modal">
            <h2 id="nc-confirm">¿Emitir la nota de crédito?</h2>
            <p>Se enviará a SUNAT y <strong>no se podrá deshacer</strong>.</p>
            <dl className="svc-facts" style={{ padding: 0 }}>
              <div><dt>Afecta a</dt><dd>{d.label} · {d.customerName}</dd></div>
              <div><dt>Motivo</dt><dd>{meta.label}</dd></div>
              <div><dt>Total estimado</dt><dd>{money(total)}</dd></div>
              <div><dt>Stock</dt><dd>{meta.restocks ? "Vuelve a los lotes de la venta" : "No cambia"}</dd></div>
              <div><dt>Dinero</dt><dd>{refund ? `Devolución por ${REFUNDS.find((r) => r.key === refund)!.label}` : "Sin devolución"}</dd></div>
            </dl>
            <div className="rx-actions" style={{ marginTop: 16 }}>
              <button type="button" className="app-btn" disabled={pending} onClick={() => setConfirming(false)}>Volver</button>
              <button type="button" className="app-btn primary" disabled={pending || needsPharmacist} autoFocus onClick={issue}>{pending ? "Emitiendo…" : "Emitir nota de crédito"}</button>
            </div>
          </div>
        </div>
      )}
    </form>
  );
}
