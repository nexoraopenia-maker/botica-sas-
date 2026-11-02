"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { registerPharmacistAction } from "@/app/app/pharmacy/actions";
import { PrescriptionForm, type RxKind } from "./prescription-form";

export function NewPrescription({ branchId, initialKind }: { branchId: string; initialKind: RxKind }) {
  const router = useRouter();
  const [kind, setKind] = useState<RxKind>(initialKind);
  const [saved, setSaved] = useState(0);
  return (
    <>
      <div className="set-form" style={{ paddingBottom: 0 }}>
        <label className="set-field"><span>Tipo de receta</span>
          <select value={kind} onChange={(e) => setKind(e.target.value as RxKind)}>
            <option value="SPECIAL">Especial (controlados)</option><option value="RETAINED">Retenida</option><option value="SIMPLE">Simple</option>
          </select></label>
      </div>
      {saved > 0 && <p className="set-msg ok" role="status" style={{ margin: "12px 20px 0" }}>Receta validada y registrada.</p>}
      <PrescriptionForm key={saved} branchId={branchId} kind={kind} submitLabel="Validar receta"
        onSaved={() => { setSaved((n) => n + 1); router.refresh(); }} />
    </>
  );
}

/** Alta del QF: requisito previo para validar recetas en la sucursal. */
export function RegisterPharmacist({ branchId, members }: { branchId: string; members: { userId: string; name: string }[] }) {
  const router = useRouter();
  const [userId, setUserId] = useState(members[0]?.userId ?? "");
  const [fullName, setFullName] = useState(members[0]?.name ?? "");
  const [cqfp, setCqfp] = useState("");
  const [director, setDirector] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    start(async () => {
      const res = await registerPharmacistAction({ branchId, userId, fullName, cqfpNumber: cqfp, isTechnicalDirector: director });
      if (res.ok) { setCqfp(""); router.refresh(); } else setError(res.error.fieldErrors ? Object.values(res.error.fieldErrors).flat()[0] ?? res.error.message : res.error.message);
    });
  }
  return (
    <form onSubmit={submit} className="set-form">
      <label className="set-field"><span>Usuario</span>
        <select value={userId} onChange={(e) => { setUserId(e.target.value); setFullName(members.find((m) => m.userId === e.target.value)?.name ?? ""); }}>
          {members.map((m) => <option key={m.userId} value={m.userId}>{m.name}</option>)}
        </select></label>
      <label className="set-field"><span>Nombre completo *</span><input value={fullName} required minLength={3} onChange={(e) => setFullName(e.target.value)} /></label>
      <label className="set-field"><span>N° de colegiatura CQFP *</span><input inputMode="numeric" maxLength={6} value={cqfp} required onChange={(e) => setCqfp(e.target.value.replace(/\D/g, ""))} /></label>
      <label className="set-check wide"><input type="checkbox" checked={director} onChange={(e) => setDirector(e.target.checked)} /> Es director técnico</label>
      {error && <p className="set-msg bad wide" role="alert">{error}</p>}
      <div className="wide rx-actions"><button type="submit" className="app-btn primary" disabled={pending || !userId}>{pending ? "Registrando…" : "Registrar químico farmacéutico"}</button></div>
    </form>
  );
}
