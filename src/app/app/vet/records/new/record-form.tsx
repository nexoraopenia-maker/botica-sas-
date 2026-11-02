"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { createRecordAction } from "@/app/app/vet/actions";

const SPECIES = [["CANINE", "Canino"], ["FELINE", "Felino"], ["BOVINE", "Bovino"], ["OVINE", "Ovino"], ["CAPRINE", "Caprino"], ["PORCINE", "Porcino"], ["EQUINE", "Equino"], ["AVIAN", "Ave"], ["CAVY", "Cuy"], ["RABBIT", "Conejo"], ["OTHER", "Otro"]] as const;
const VISITS = [["CONSULTATION", "Consulta"], ["VACCINATION", "Vacunación"], ["DEWORMING", "Desparasitación"], ["CONTROL", "Control"], ["SURGERY", "Cirugía"], ["HOSPITALIZATION", "Hospitalización"], ["GROOMING", "Baño y corte"]] as const;
type Species = (typeof SPECIES)[number][0];
type Visit = (typeof VISITS)[number][0];

const n = (v: string) => (v.trim() ? Number(v.replace(",", ".")) : undefined);

export function RecordForm({ branchId, pets, initialPetId }: { branchId: string; pets: { id: string; label: string }[]; initialPetId?: string }) {
  const router = useRouter();
  const [mode, setMode] = useState<"existing" | "new">(initialPetId || pets.length > 0 ? "existing" : "new");
  const [petId, setPetId] = useState(initialPetId ?? pets[0]?.id ?? "");
  const [owner, setOwner] = useState({ ownerName: "", ownerDni: "", ownerWhatsapp: "", petName: "", breed: "" });
  const [species, setSpecies] = useState<Species>("CANINE");
  const [sex, setSex] = useState<"MALE" | "FEMALE" | "UNKNOWN">("UNKNOWN");
  const [visitType, setVisitType] = useState<Visit>("CONSULTATION");
  const [c, setC] = useState({ reason: "", anamnesis: "", weight: "", temp: "", diagnosis: "", treatment: "", next: "" });
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const setO = (k: keyof typeof owner, v: string) => setOwner((o) => ({ ...o, [k]: v }));
  const setF = (k: keyof typeof c, v: string) => setC((o) => ({ ...o, [k]: v }));

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    start(async () => {
      const res = await createRecordAction({
        branchId, visitType, reason: c.reason, anamnesis: c.anamnesis, weightKg: n(c.weight), temperatureC: n(c.temp),
        diagnosis: c.diagnosis, treatment: c.treatment, nextControlAt: c.next || undefined,
        ...(mode === "existing" ? { petId } : { newPatient: { ...owner, species, sex } }),
      });
      if (!res.ok) { setError(res.error.fieldErrors ? Object.values(res.error.fieldErrors).flat()[0] ?? res.error.message : res.error.message); return; }
      router.push(`/app/vet/pets/${res.data.petId}`);
    });
  }

  return (
    <form onSubmit={submit}>
      <div className="set-form">
        <div className="set-tabs wide" role="tablist" aria-label="Paciente" style={{ marginBottom: 0 }}>
          <button type="button" role="tab" aria-selected={mode === "existing"} className={mode === "existing" ? "on" : ""} disabled={pets.length === 0} onClick={() => setMode("existing")}>Paciente registrado</button>
          <button type="button" role="tab" aria-selected={mode === "new"} className={mode === "new" ? "on" : ""} onClick={() => setMode("new")}>Paciente nuevo</button>
        </div>
        {mode === "existing" ? (
          <label className="set-field wide"><span>Paciente *</span>
            <select value={petId} onChange={(e) => setPetId(e.target.value)} required>{pets.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}</select></label>
        ) : (
          <>
            <label className="set-field"><span>Nombre del paciente *</span><input value={owner.petName} required onChange={(e) => setO("petName", e.target.value)} /></label>
            <label className="set-field"><span>Especie *</span><select value={species} onChange={(e) => setSpecies(e.target.value as Species)}>{SPECIES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
            <label className="set-field"><span>Raza</span><input value={owner.breed} onChange={(e) => setO("breed", e.target.value)} /></label>
            <label className="set-field"><span>Sexo</span><select value={sex} onChange={(e) => setSex(e.target.value as typeof sex)}><option value="UNKNOWN">No indicado</option><option value="MALE">Macho</option><option value="FEMALE">Hembra</option></select></label>
            <label className="set-field"><span>Propietario *</span><input value={owner.ownerName} required minLength={3} onChange={(e) => setO("ownerName", e.target.value)} /></label>
            <label className="set-field"><span>DNI del propietario</span><input inputMode="numeric" maxLength={8} value={owner.ownerDni} onChange={(e) => setO("ownerDni", e.target.value.replace(/\D/g, ""))} /></label>
            <label className="set-field"><span>WhatsApp del propietario</span><input inputMode="tel" value={owner.ownerWhatsapp} onChange={(e) => setO("ownerWhatsapp", e.target.value)} placeholder="987654321" /><small>Para recordatorios de vacunas.</small></label>
          </>
        )}
        <label className="set-field"><span>Tipo de atención *</span><select value={visitType} onChange={(e) => setVisitType(e.target.value as Visit)}>{VISITS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
        <label className="set-field"><span>Peso (kg)</span><input inputMode="decimal" value={c.weight} onChange={(e) => setF("weight", e.target.value)} /></label>
        <label className="set-field"><span>Temperatura (°C)</span><input inputMode="decimal" value={c.temp} onChange={(e) => setF("temp", e.target.value)} /></label>
        <label className="set-field wide"><span>Motivo de consulta *</span><input value={c.reason} required minLength={3} onChange={(e) => setF("reason", e.target.value)} /></label>
        <label className="set-field wide"><span>Anamnesis</span><input value={c.anamnesis} onChange={(e) => setF("anamnesis", e.target.value)} /></label>
        <label className="set-field wide"><span>Diagnóstico</span><input value={c.diagnosis} onChange={(e) => setF("diagnosis", e.target.value)} /></label>
        <label className="set-field wide"><span>Tratamiento</span><input value={c.treatment} onChange={(e) => setF("treatment", e.target.value)} /></label>
        <label className="set-field"><span>Próximo control</span><input type="date" value={c.next} onChange={(e) => setF("next", e.target.value)} /></label>
        {error && <p className="set-msg bad wide" role="alert">{error}</p>}
        <div className="wide rx-actions"><button type="submit" className="app-btn primary" disabled={pending}>{pending ? "Guardando…" : "Guardar historia clínica"}</button></div>
      </div>
    </form>
  );
}
