"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { runIngestionAction, uploadInvoiceAction } from "../actions";

type Step = "idle" | "preparing" | "uploading" | "reading" | "error";
const ACCEPT = "image/jpeg,image/png,image/webp,application/pdf,application/xml,text/xml,.xml";
const MAX_SIDE = 2000;

/** Reduce fotos grandes del celular (la API de visión rechaza imágenes > 5 MB y subir 8 MB es lento). */
async function downscale(file: File): Promise<File> {
  if (!file.type.startsWith("image/") || file.size < 1_500_000) return file;
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", 0.85));
  return blob ? new File([blob], file.name.replace(/\.\w+$/, ".jpg"), { type: "image/jpeg" }) : file;
}

export function Uploader({ branchId, aiEnabled }: { branchId: string; aiEnabled: boolean }) {
  const router = useRouter();
  const fileInput = useRef<HTMLInputElement>(null);
  const cameraInput = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState<Step>("idle");
  const [error, setError] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);
  const [name, setName] = useState<string | null>(null);

  async function handle(file: File | undefined) {
    if (!file) return;
    setError(null);
    setName(file.name);
    const isXml = file.type.includes("xml") || file.name.toLowerCase().endsWith(".xml");
    if (!isXml && !aiEnabled) {
      setStep("error");
      setError("La lectura de fotos y PDF con IA no está configurada en este servidor. Puede cargar la factura electrónica en XML.");
      return;
    }
    try {
      setStep("preparing");
      const prepared = isXml && !file.type.includes("xml") ? new File([file], file.name, { type: "application/xml" }) : await downscale(file);
      setStep("uploading");
      const form = new FormData();
      form.set("branchId", branchId);
      form.set("file", prepared);
      const up = await uploadInvoiceAction(form);
      if (!up.ok) throw new Error(up.error.message);
      if (!up.data.duplicate) {
        setStep("reading");
        const run = await runIngestionAction(up.data.jobId);
        if (!run.ok) throw new Error(run.error.message);
      }
      router.push(`/app/purchases/ai?job=${up.data.jobId}`);
    } catch (e) {
      setStep("error");
      setError(e instanceof Error ? e.message : "No se pudo procesar el archivo.");
    }
  }

  const busy = step === "preparing" || step === "uploading" || step === "reading";
  const label = { idle: "", preparing: "Preparando imagen…", uploading: "Subiendo archivo…", reading: isReadingText(name), error: "" }[step];

  return (
    <div
      className={`ai-drop${drag ? " drag" : ""}${busy ? " busy" : ""}`}
      onDragOver={(e) => { e.preventDefault(); if (!busy) setDrag(true); }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => { e.preventDefault(); setDrag(false); if (!busy) void handle(e.dataTransfer.files[0]); }}
    >
      <input ref={fileInput} type="file" accept={ACCEPT} hidden onChange={(e) => { void handle(e.target.files?.[0]); e.target.value = ""; }} />
      <input ref={cameraInput} type="file" accept="image/*" capture="environment" hidden onChange={(e) => { void handle(e.target.files?.[0]); e.target.value = ""; }} />

      {busy ? (
        <div className="ai-progress" role="status" aria-live="polite">
          <span className="ai-spinner" aria-hidden />
          <strong>{label}</strong>
          <span className="app-muted">{name}</span>
          {step === "reading" && <span className="app-muted">Suele tomar entre 10 y 30 segundos.</span>}
        </div>
      ) : (
        <>
          <div className="ai-drop-icon" aria-hidden>
            <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 16V4M7 9l5-5 5 5M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" />
            </svg>
          </div>
          <h3>Arrastre aquí la factura de compra</h3>
          <p className="app-muted">Foto (JPG, PNG), PDF o XML de la factura electrónica · máx. 10 MB</p>
          <div className="ai-drop-actions">
            <button type="button" className="app-btn primary" onClick={() => fileInput.current?.click()}>Elegir archivo</button>
            <button type="button" className="app-btn ai-camera-btn" onClick={() => cameraInput.current?.click()}>Tomar foto</button>
          </div>
          {error && <p className="set-msg bad" role="alert">{error}</p>}
          {!aiEnabled && !error && <p className="app-muted ai-note">Lectura con IA no configurada: por ahora solo se aceptan facturas XML.</p>}
        </>
      )}
    </div>
  );
}

function isReadingText(name: string | null): string {
  return name?.toLowerCase().endsWith(".xml") ? "Leyendo XML de la factura…" : "Leyendo la factura con IA…";
}
