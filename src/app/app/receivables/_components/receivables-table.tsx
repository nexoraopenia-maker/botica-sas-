"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import type { CollectionScan, Receivable } from "@/lib/services/collections";
import { PaymentForm } from "@/app/app/services/_components/order-controls";
import { runCollectionRemindersAction } from "../actions";

const TONE = { overdue: "red", soon: "amber", ok: "green" } as const;
const money = (v: string) => `S/ ${Number(v).toLocaleString("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const dmy = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

export function ReceivablesTable({ rows, canOpenOrders }: { rows: Receivable[]; canOpenOrders: boolean }) {
  const [paying, setPaying] = useState<Receivable | null>(null);
  return (
    <>
      <div className="app-table-wrap"><table className="app-table stack">
        <thead><tr><th>Semáforo</th><th>Cliente</th><th>Orden</th><th>Vence</th><th className="num">Total</th><th className="num">Saldo</th><th /></tr></thead>
        <tbody>{rows.map((r) => (
          <tr key={r.id}>
            <td data-label="Semáforo"><span className={`app-pill ${TONE[r.light]}`}><span className="rcv-dot" aria-hidden />{r.label}</span></td>
            <td data-label="Cliente"><strong>{r.customerName}</strong><span className="app-sub">{r.phone ?? "Sin WhatsApp"}{r.phone && !r.optIn ? " · no acepta recordatorios" : ""}</span></td>
            <td data-label="Orden">
              {canOpenOrders ? <Link className="app-link" href={`/app/services/${r.id}`}>{r.code}</Link> : r.code}
              <span className="app-sub">{r.item}{r.invoice ? ` · Factura ${r.invoice}` : ""}</span>
            </td>
            <td data-label="Vence">{dmy(r.dueDate)}</td>
            <td data-label="Total" className="num">{money(r.total)}</td>
            <td data-label="Saldo" className="num"><strong>{money(r.balance)}</strong></td>
            <td data-label=""><button type="button" className="app-btn" onClick={() => setPaying(r)}>Cobrar</button></td>
          </tr>
        ))}</tbody>
      </table></div>
      {paying && (
        <div className="pos-overlay" role="dialog" aria-modal="true" aria-labelledby="pay-title">
          <div className="pos-modal">
            <h2 id="pay-title">Registrar cobro</h2>
            <p className="app-muted">{paying.code} · {paying.customerName} · Saldo {money(paying.balance)}</p>
            <PaymentForm orderId={paying.id} balance={paying.balance} onDone={() => setPaying(null)} />
          </div>
        </div>
      )}
    </>
  );
}

/** Tarea de cobranza: se ejecuta sola cada día y aquí se puede simular o lanzar a mano. */
export function CollectionReminders({ soonDays, canRun, canSend }: { soonDays: number; canRun: boolean; canSend: boolean }) {
  const [scan, setScan] = useState<CollectionScan | null>(null);
  const [msg, setMsg] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const [pending, start] = useTransition();
  const run = (dry: boolean) => start(async () => {
    setMsg(null);
    const r = await runCollectionRemindersAction(dry);
    if (!r.ok) { setMsg({ tone: "bad", text: r.error.message }); return; }
    setScan(r.data);
    if (!dry) setMsg({ tone: "ok", text: `${r.data.queued} recordatorio(s) encolados para envío.` });
  });
  return (
    <>
      <p className="app-muted set-pad" style={{ marginBottom: 0 }}>
        Avisa por WhatsApp una vez, dentro de los {soonDays} día(s) previos al vencimiento, a los clientes que aceptaron recibirlos.
        En Meta usa la plantilla <code>recordatorio_cobranza</code>, que debe estar aprobada en su cuenta. El plazo se cambia en Configuración → WhatsApp.
      </p>
      {canRun && (
        <div className="rx-actions set-pad">
          <button type="button" className="app-btn" disabled={pending} onClick={() => run(true)}>Simular (no envía nada)</button>
          <button type="button" className="app-btn primary" disabled={pending || !canSend} onClick={() => run(false)}>Ejecutar ahora</button>
        </div>
      )}
      {msg && <p className={`set-msg ${msg.tone}`} role={msg.tone === "bad" ? "alert" : "status"} style={{ margin: "0 20px 14px" }}>{msg.text}</p>}
      {scan && (
        scan.tenants === 0 ? <p className="app-muted set-pad">Active WhatsApp y sus recordatorios en Configuración → WhatsApp para ejecutar esta tarea.</p> : (
          <>
            {scan.skippedNoConsent > 0 && <p className="app-muted set-pad" style={{ marginBottom: 0 }}>{scan.skippedNoConsent} crédito(s) por vencer sin aviso: el cliente no aceptó recordatorios o no tiene WhatsApp.</p>}
            {scan.items.length === 0 ? <p className="app-muted set-pad">No hay recordatorios que enviar en este plazo.</p> : (
              <div className="app-table-wrap"><table className="app-table stack">
                <thead><tr><th>Orden</th><th>Destinatario</th><th>Mensaje</th><th>Estado</th></tr></thead>
                <tbody>{scan.items.map((i) => (
                  <tr key={i.label}>
                    <td data-label="Orden"><strong>{i.label}</strong></td>
                    <td data-label="Destinatario">{i.recipient}</td>
                    <td data-label="Mensaje">{i.text}</td>
                    <td data-label="Estado"><span className={`app-pill ${i.isNew ? "blue" : "gray"}`}>{i.isNew ? (scan.dryRun ? "Se enviaría" : "Encolado") : "Ya enviado"}</span></td>
                  </tr>
                ))}</tbody>
              </table></div>
            )}
          </>
        )
      )}
    </>
  );
}
