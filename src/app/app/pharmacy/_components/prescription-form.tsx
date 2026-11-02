"use client";

import { useState, useTransition } from "react";
import { registerPrescriptionAction } from "@/app/app/pharmacy/actions";
import { limaToday } from "./today";

export type RxKind = "SIMPLE" | "RETAINED" | "SPECIAL";

/** Datos de la receta validada por el QF. Lo usan el POS (modal obligatorio) y la página de Recetas. */
export function PrescriptionForm({ branchId, kind, patientDefault = "", submitLabel, onSaved, onCancel }: {
  branchId: string;
  kind: RxKind;
  patientDefault?: string;
  submitLabel: string;
  onSaved: (prescriptionId: string) => void;
  onCancel?: () => void;
}) {
  const [patientName, setPatientName] = useState(patientDefault);
  const [patientDoc, setPatientDoc] = useState("");
  const [prescriberName, setPrescriberName] = useState("");
  const [prescriberDoc, setPrescriberDoc] = useState("");
  const [prescriberCmp, setPrescriberCmp] = useState("");
  const [profession, setProfession] = useState<"MEDICO" | "VETERINARIO" | "ODONTOLOGO" | "OBSTETRA">("MEDICO");
  const [issuedAt, setIssuedAt] = useState(limaToday());
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const controlled = kind === "SPECIAL";

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (controlled && !/^\d{8}$/.test(prescriberDoc)) return setError("Ingrese el DNI del médico (8 dígitos).");
    if (!/^\d{3,6}$/.test(prescriberCmp)) return setError("Ingrese el N° de colegiatura (3 a 6 dígitos).");
    start(async () => {
      const res = await registerPrescriptionAction({
        branchId, kind, patientName, patientDoc: patientDoc || undefined, prescriberName, prescriberCmp,
        prescriberDoc: prescriberDoc || undefined, prescriberProfession: profession, issuedAt, retained: kind !== "SIMPLE",
      });
      if (res.ok) onSaved(res.data.prescriptionId);
      else setError(res.error.fieldErrors ? Object.values(res.error.fieldErrors).flat()[0] ?? res.error.message : res.error.message);
    });
  }

  return (
    <form onSubmit={submit} className="set-form rx-form">
      <label className="set-field"><span>DNI del médico {controlled && "*"}</span>
        <input inputMode="numeric" maxLength={8} value={prescriberDoc} required={controlled} autoFocus onChange={(e) => setPrescriberDoc(e.target.value.replace(/\D/g, ""))} /></label>
      <label className="set-field"><span>N° de colegiatura *</span>
        <input inputMode="numeric" maxLength={6} value={prescriberCmp} required onChange={(e) => setPrescriberCmp(e.target.value.replace(/\D/g, ""))} /></label>
      <label className="set-field wide"><span>Nombre del prescriptor *</span>
        <input value={prescriberName} required minLength={3} onChange={(e) => setPrescriberName(e.target.value)} /></label>
      <label className="set-field"><span>Profesión</span>
        <select value={profession} onChange={(e) => setProfession(e.target.value as typeof profession)}>
          <option value="MEDICO">Médico</option><option value="VETERINARIO">Veterinario</option>
          <option value="ODONTOLOGO">Odontólogo</option><option value="OBSTETRA">Obstetra</option>
        </select></label>
      <label className="set-field"><span>Fecha de la receta *</span>
        <input type="date" value={issuedAt} required onChange={(e) => setIssuedAt(e.target.value)} /></label>
      <label className="set-field"><span>Paciente *</span>
        <input value={patientName} required minLength={3} onChange={(e) => setPatientName(e.target.value)} /></label>
      <label className="set-field"><span>DNI del paciente</span>
        <input inputMode="numeric" maxLength={15} value={patientDoc} onChange={(e) => setPatientDoc(e.target.value)} /></label>
      {kind !== "SIMPLE" && <p className="app-muted wide" style={{ margin: 0 }}>La receta queda retenida en el establecimiento y no puede volver a usarse.</p>}
      {error && <p className="set-msg bad wide" role="alert">{error}</p>}
      <div className="wide rx-actions">
        {onCancel && <button type="button" className="app-btn" onClick={onCancel}>Cancelar</button>}
        <button type="submit" className="app-btn primary" disabled={pending}>{pending ? "Validando…" : submitLabel}</button>
      </div>
    </form>
  );
}
