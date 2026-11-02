"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { addEvidenceAction, createOrderAction } from "@/app/app/services/actions";
import { MAX_EVIDENCE } from "@/lib/services/rules";
import { limaToday } from "@/app/app/pharmacy/_components/today";
import { compressPhoto } from "./photos";

type DocType = "DNI" | "RUC" | "CE";
const firstError = (e: { message: string; fieldErrors?: Record<string, string[]> }) => (e.fieldErrors ? Object.values(e.fieldErrors).flat()[0] ?? e.message : e.message);

/** Recepción del vehículo o pieza: datos del cliente, trabajo, condiciones de cobro y fotos del estado de ingreso. */
export function OrderForm({ branchId }: { branchId: string }) {
  const router = useRouter();
  const key = useRef<string>(crypto.randomUUID());
  const created = useRef<string | null>(null);
  const [docType, setDocType] = useState<DocType>("DNI");
  const [f, setF] = useState({ docNumber: "", name: "", phone: "", item: "", plate: "", mileage: "", problem: "", notes: "", total: "", dueDate: "", invoice: "" });
  const [optIn, setOptIn] = useState(false);
  const [paymentType, setPaymentType] = useState<"CASH" | "CREDIT">("CASH");
  const [photos, setPhotos] = useState<{ file: File; preview: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const set = (k: keyof typeof f, v: string) => setF((o) => ({ ...o, [k]: v }));

  useEffect(() => () => photos.forEach((p) => URL.revokeObjectURL(p.preview)), []); // eslint-disable-line react-hooks/exhaustive-deps

  async function pick(list: FileList | null) {
    if (!list) return;
    setError(null);
    const room = MAX_EVIDENCE - photos.length;
    if (list.length > room) setError(`Máximo ${MAX_EVIDENCE} fotos por orden.`);
    for (const file of [...list].slice(0, room)) {
      try {
        const small = await compressPhoto(file);
        setPhotos((p) => [...p, { file: small, preview: URL.createObjectURL(small) }]);
      } catch {
        setError(`No se pudo leer ${file.name}: use una foto JPG, PNG o WebP.`);
      }
    }
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    start(async () => {
      // Si las fotos fallaron en un intento anterior, la orden ya existe: no se vuelve a crear
      if (!created.current) {
        setProgress("Registrando la orden…");
        const res = await createOrderAction({
          idempotencyKey: key.current, branchId,
          customer: { docType, docNumber: f.docNumber, name: f.name, phone: f.phone, whatsappOptIn: optIn },
          itemDescription: f.item, plate: f.plate, mileage: f.mileage ? Number(f.mileage) : undefined, problem: f.problem, notes: f.notes,
          paymentType, total: f.total || "0", dueDate: paymentType === "CREDIT" ? f.dueDate : undefined, invoiceNumber: f.invoice,
        });
        if (!res.ok) { setProgress(null); setError(firstError(res.error)); return; }
        created.current = res.data.orderId;
      }
      const orderId = created.current;
      let failed = 0;
      for (const [i, p] of photos.entries()) {
        setProgress(`Subiendo foto ${i + 1} de ${photos.length}…`);
        const form = new FormData();
        form.set("orderId", orderId);
        form.set("file", p.file);
        const up = await addEvidenceAction(form).catch(() => null);
        if (!up?.ok) failed++;
      }
      router.push(`/app/services/${orderId}${failed ? `?fotos_fallidas=${failed}` : ""}`);
    });
  }

  return (
    <form onSubmit={submit}>
      <div className="set-form">
        <h3 className="wide svc-title">Cliente</h3>
        <label className="set-field"><span>Documento *</span>
          <select value={docType} onChange={(e) => { setDocType(e.target.value as DocType); set("docNumber", ""); }}>
            <option value="DNI">DNI</option><option value="RUC">RUC</option><option value="CE">Carné de extranjería</option>
          </select></label>
        <label className="set-field"><span>Número *</span>
          <input value={f.docNumber} required maxLength={docType === "RUC" ? 11 : docType === "DNI" ? 8 : 12} inputMode={docType === "CE" ? "text" : "numeric"}
            onChange={(e) => set("docNumber", docType === "CE" ? e.target.value : e.target.value.replace(/\D/g, ""))} /></label>
        <label className="set-field"><span>Nombre o razón social *</span><input value={f.name} required minLength={3} onChange={(e) => set("name", e.target.value)} /></label>
        <label className="set-field"><span>WhatsApp{optIn ? " *" : ""}</span><input inputMode="tel" value={f.phone} required={optIn} placeholder="987654321" onChange={(e) => set("phone", e.target.value)} /></label>
        <label className="set-check wide"><input type="checkbox" checked={optIn} onChange={(e) => setOptIn(e.target.checked)} /> El cliente acepta recibir recordatorios de pago por WhatsApp</label>

        <h3 className="wide svc-title">Vehículo o pieza</h3>
        <label className="set-field wide"><span>Descripción *</span><input value={f.item} required minLength={2} placeholder="Toyota Hilux 2018 blanca / Alternador Bosch" onChange={(e) => set("item", e.target.value)} /></label>
        <label className="set-field"><span>Placa</span><input value={f.plate} maxLength={10} onChange={(e) => set("plate", e.target.value.toUpperCase())} /></label>
        <label className="set-field"><span>Kilometraje</span><input inputMode="numeric" value={f.mileage} onChange={(e) => set("mileage", e.target.value.replace(/\D/g, ""))} /></label>
        <label className="set-field wide"><span>Problema o trabajo solicitado *</span><input value={f.problem} required minLength={3} onChange={(e) => set("problem", e.target.value)} /></label>
        <label className="set-field wide"><span>Observaciones de ingreso</span><input value={f.notes} placeholder="Rayón en puerta izquierda, sin radio…" onChange={(e) => set("notes", e.target.value)} /></label>

        <div className="set-field wide">
          <span>Fotos de ingreso ({photos.length}/{MAX_EVIDENCE})</span>
          <div className="svc-photos">
            {photos.map((p, i) => (
              <div key={p.preview} className="svc-photo">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={p.preview} alt={`Foto ${i + 1} del ingreso`} />
                <button type="button" aria-label={`Quitar foto ${i + 1}`} onClick={() => { URL.revokeObjectURL(p.preview); setPhotos((l) => l.filter((x) => x !== p)); }}>×</button>
              </div>
            ))}
            {photos.length < MAX_EVIDENCE && (
              <label className="svc-photo-add">
                <input type="file" accept="image/jpeg,image/png,image/webp" multiple capture="environment" onChange={(e) => { void pick(e.target.files); e.target.value = ""; }} />
                + Agregar foto
              </label>
            )}
          </div>
        </div>

        <h3 className="wide svc-title">Cobro</h3>
        <div className="set-tabs wide" role="radiogroup" aria-label="Forma de pago" style={{ marginBottom: 0 }}>
          {([["CASH", "Contado"], ["CREDIT", "Crédito"]] as const).map(([k, l]) => (
            <button key={k} type="button" role="radio" aria-checked={paymentType === k} className={paymentType === k ? "on" : ""} onClick={() => setPaymentType(k)}>{l}</button>
          ))}
        </div>
        <label className="set-field"><span>Monto (S/){paymentType === "CREDIT" ? " *" : ""}</span>
          <input inputMode="decimal" value={f.total} required={paymentType === "CREDIT"} placeholder="Puede definirlo después" onChange={(e) => set("total", e.target.value)} /></label>
        {paymentType === "CREDIT" && <label className="set-field"><span>Vencimiento *</span><input type="date" value={f.dueDate} min={limaToday()} required onChange={(e) => set("dueDate", e.target.value)} /></label>}
        <label className="set-field"><span>N° de factura</span><input value={f.invoice} placeholder="F001-123" onChange={(e) => set("invoice", e.target.value.toUpperCase())} /></label>

        {error && <p className="set-msg bad wide" role="alert">{error}</p>}
        <div className="wide rx-actions">
          {pending && progress && <span className="app-muted" role="status">{progress}</span>}
          <button type="submit" className="app-btn primary" disabled={pending}>{pending ? "Guardando…" : "Registrar orden"}</button>
        </div>
      </div>
    </form>
  );
}
