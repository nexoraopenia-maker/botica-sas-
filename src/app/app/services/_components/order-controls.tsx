"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { addEvidenceAction, changeStatusAction, registerPaymentAction, updateTermsAction } from "@/app/app/services/actions";
import { canTransition, deliveryBlocker, MAX_EVIDENCE, ORDER_STATUSES, STATUS_LABEL, type OrderStatus } from "@/lib/services/rules";
import { limaToday } from "@/app/app/pharmacy/_components/today";
import { compressPhoto } from "./photos";

const firstError = (e: { message: string; fieldErrors?: Record<string, string[]> }) => (e.fieldErrors ? Object.values(e.fieldErrors).flat()[0] ?? e.message : e.message);
const METHODS = [["EFECTIVO", "Efectivo"], ["YAPE", "Yape"], ["PLIN", "Plin"], ["TARJETA", "Tarjeta"], ["TRANSFERENCIA", "Transferencia"]] as const;

/** Avance del trabajo: un paso adelante o atrás; entregar valida el cobro. */
export function StatusControls({ orderId, status, paymentType, total, balanceDue, dueDate }: {
  orderId: string; status: OrderStatus; paymentType: "CASH" | "CREDIT"; total: string; balanceDue: string; dueDate: string | null;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const blocker = deliveryBlocker({ paymentType, total: Number(total), balanceDue: Number(balanceDue), dueDate });
  function go(to: OrderStatus) {
    setError(null);
    start(async () => {
      const res = await changeStatusAction({ orderId, status: to });
      if (res.ok) router.refresh(); else setError(firstError(res.error));
    });
  }
  return (
    <div className="svc-status">
      <ol className="svc-steps" aria-label="Estado de la orden">
        {ORDER_STATUSES.map((s) => (
          <li key={s} className={ORDER_STATUSES.indexOf(s) <= ORDER_STATUSES.indexOf(status) ? "done" : ""} aria-current={s === status ? "step" : undefined}>{STATUS_LABEL[s]}</li>
        ))}
      </ol>
      {status === "DELIVERED" ? <p className="app-muted" style={{ margin: 0 }}>Orden entregada.</p> : (
        <div className="rx-actions">
          {ORDER_STATUSES.filter((s) => canTransition(status, s)).map((s) => {
            const forward = ORDER_STATUSES.indexOf(s) > ORDER_STATUSES.indexOf(status);
            return (
              <button key={s} type="button" className={`app-btn${forward ? " primary" : ""}`} disabled={pending || (s === "DELIVERED" && !!blocker)} onClick={() => go(s)}>
                {forward ? `Marcar como ${STATUS_LABEL[s].toLowerCase()}` : `Volver a ${STATUS_LABEL[s].toLowerCase()}`}
              </button>
            );
          })}
        </div>
      )}
      {status === "READY" && blocker && <p className="set-msg bad" role="status" style={{ marginTop: 10 }}>{blocker}</p>}
      {error && <p className="set-msg bad" role="alert" style={{ marginTop: 10 }}>{error}</p>}
    </div>
  );
}

/** Cobro parcial o total. La clave se renueva tras cada éxito: reintentar el mismo envío no cobra dos veces. */
export function PaymentForm({ orderId, balance, onDone }: { orderId: string; balance: string; onDone?: () => void }) {
  const router = useRouter();
  const key = useRef<string>(crypto.randomUUID());
  const [amount, setAmount] = useState(balance);
  const [method, setMethod] = useState<(typeof METHODS)[number][0]>("EFECTIVO");
  const [reference, setReference] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    start(async () => {
      const res = await registerPaymentAction({ idempotencyKey: key.current, orderId, amount, method, reference });
      if (!res.ok) { setError(firstError(res.error)); return; }
      key.current = crypto.randomUUID();
      setAmount(res.data.balanceDue);
      setReference("");
      router.refresh();
      onDone?.();
    });
  }
  return (
    <form onSubmit={submit} className="set-form">
      <label className="set-field"><span>Monto (S/) *</span><input inputMode="decimal" value={amount} required autoFocus={!!onDone} onChange={(e) => setAmount(e.target.value)} /></label>
      <label className="set-field"><span>Medio de pago</span><select value={method} onChange={(e) => setMethod(e.target.value as typeof method)}>{METHODS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
      <label className="set-field wide"><span>Referencia</span><input value={reference} maxLength={60} placeholder="N° de operación (opcional)" onChange={(e) => setReference(e.target.value)} /></label>
      {error && <p className="set-msg bad wide" role="alert">{error}</p>}
      <div className="wide rx-actions">
        {onDone && <button type="button" className="app-btn" onClick={onDone}>Cancelar</button>}
        <button type="submit" className="app-btn primary" disabled={pending}>{pending ? "Registrando…" : "Registrar cobro"}</button>
      </div>
    </form>
  );
}

export function TermsForm({ orderId, paymentType: initial, total, dueDate, invoice, delivered }: {
  orderId: string; paymentType: "CASH" | "CREDIT"; total: string; dueDate: string | null; invoice: string | null; delivered: boolean;
}) {
  const router = useRouter();
  const [paymentType, setPaymentType] = useState(initial);
  const [amount, setAmount] = useState(total);
  const [due, setDue] = useState(dueDate ?? "");
  const [inv, setInv] = useState(invoice ?? "");
  const [msg, setMsg] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const [pending, start] = useTransition();
  function submit(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    start(async () => {
      const res = await updateTermsAction({ orderId, paymentType, total: amount, dueDate: paymentType === "CREDIT" ? due : undefined, invoiceNumber: inv });
      if (!res.ok) { setMsg({ tone: "bad", text: firstError(res.error) }); return; }
      setMsg({ tone: "ok", text: "Condiciones actualizadas." });
      router.refresh();
    });
  }
  return (
    <form onSubmit={submit} className="set-form">
      <label className="set-field"><span>Forma de pago</span>
        <select value={paymentType} disabled={delivered} onChange={(e) => setPaymentType(e.target.value as "CASH" | "CREDIT")}><option value="CASH">Contado</option><option value="CREDIT">Crédito</option></select></label>
      <label className="set-field"><span>Monto total (S/)</span><input inputMode="decimal" value={amount} disabled={delivered} onChange={(e) => setAmount(e.target.value)} /></label>
      {paymentType === "CREDIT" && <label className="set-field"><span>Vencimiento *</span><input type="date" value={due} min={limaToday()} required onChange={(e) => setDue(e.target.value)} /></label>}
      <label className="set-field"><span>N° de factura</span><input value={inv} placeholder="F001-123" onChange={(e) => setInv(e.target.value.toUpperCase())} /></label>
      {msg && <p className={`set-msg ${msg.tone} wide`} role={msg.tone === "bad" ? "alert" : "status"}>{msg.text}</p>}
      <div className="wide rx-actions"><button type="submit" className="app-btn" disabled={pending}>{pending ? "Guardando…" : "Guardar condiciones"}</button></div>
    </form>
  );
}

export function AddEvidence({ orderId, count }: { orderId: string; count: number }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  if (count >= MAX_EVIDENCE) return <p className="app-muted set-pad">Se alcanzó el máximo de {MAX_EVIDENCE} fotos.</p>;
  function upload(list: FileList | null) {
    if (!list?.length) return;
    setError(null);
    start(async () => {
      for (const file of [...list].slice(0, MAX_EVIDENCE - count)) {
        try {
          const form = new FormData();
          form.set("orderId", orderId);
          form.set("file", await compressPhoto(file));
          const res = await addEvidenceAction(form);
          if (!res.ok) { setError(firstError(res.error)); break; }
        } catch {
          setError(`No se pudo subir ${file.name}: use una foto JPG, PNG o WebP de menos de 4 MB.`);
          break;
        }
      }
      router.refresh();
    });
  }
  return (
    <div className="set-pad">
      <label className={`app-btn${pending ? " disabled" : ""}`} style={{ width: "fit-content" }}>
        <input type="file" hidden disabled={pending} accept="image/jpeg,image/png,image/webp" multiple capture="environment" onChange={(e) => { upload(e.target.files); e.target.value = ""; }} />
        {pending ? "Subiendo…" : "+ Agregar foto"}
      </label>
      {error && <p className="set-msg bad" role="alert" style={{ marginTop: 10 }}>{error}</p>}
    </div>
  );
}
