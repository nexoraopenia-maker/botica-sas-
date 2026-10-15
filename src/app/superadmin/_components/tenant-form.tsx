"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  createTenantAction, setModulesAction, updateTenantAction, validateRucAction,
} from "@/app/superadmin/actions";
import {
  BUSINESS_LINES, MODULES, slugify, suggestedModules, type BusinessLineUI, type ModuleKeyUI,
} from "@/app/superadmin/_components/catalog";
import { useReauth } from "@/app/superadmin/_components/use-reauth";

export interface PlanOption {
  id: string;
  name: string;
  monthlyPrice: string;
  includedModules: string[];
}

export interface TenantFormValues {
  ruc: string;
  legalName: string;
  tradeName: string;
  fiscalAddress: string;
  ubigeo: string;
  department: string;
  province: string;
  district: string;
  contactName: string;
  contactEmail: string;
  contactPhone: string;
  businessLines: BusinessLineUI[];
  modules: ModuleKeyUI[];
}

type Props =
  | { mode: "create"; plans: PlanOption[] }
  | { mode: "edit"; tenantId: string; initial: TenantFormValues };

const EMPTY: TenantFormValues = {
  ruc: "", legalName: "", tradeName: "", fiscalAddress: "", ubigeo: "", department: "", province: "", district: "",
  contactName: "", contactEmail: "", contactPhone: "", businessLines: [], modules: ["CORE"],
};

type Errors = Record<string, string[] | undefined>;

export function TenantForm(props: Props) {
  const router = useRouter();
  const { run, dialog } = useReauth();
  const [pending, startTransition] = useTransition();
  const [v, setV] = useState<TenantFormValues>(props.mode === "edit" ? props.initial : EMPTY);
  const [planId, setPlanId] = useState(props.mode === "create" ? (props.plans[0]?.id ?? "") : "");
  const [adminEmail, setAdminEmail] = useState("");
  const [adminFullName, setAdminFullName] = useState("");
  const [modulesTouched, setModulesTouched] = useState(props.mode === "edit");
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [rucInfo, setRucInfo] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);

  const plans = props.mode === "create" ? props.plans : [];
  const plan = plans.find((p) => p.id === planId);
  const slug = useMemo(() => slugify(v.tradeName || v.legalName, v.ruc), [v.tradeName, v.legalName, v.ruc]);

  const set = <K extends keyof TenantFormValues>(k: K, value: TenantFormValues[K]) => setV((prev) => ({ ...prev, [k]: value }));

  // Mientras no se toquen los módulos a mano, se sugieren según rubros y plan
  const applySuggestion = (lines: BusinessLineUI[], planModules: string[]) => {
    if (!modulesTouched) set("modules", suggestedModules(lines, planModules));
  };

  const toggleLine = (key: BusinessLineUI) => {
    const lines = v.businessLines.includes(key) ? v.businessLines.filter((l) => l !== key) : [...v.businessLines, key];
    setV((prev) => ({ ...prev, businessLines: lines }));
    applySuggestion(lines, plan?.includedModules ?? []);
  };

  const toggleModule = (key: ModuleKeyUI) => {
    if (key === "CORE") return;
    setModulesTouched(true);
    setV((prev) => {
      let mods = prev.modules.includes(key) ? prev.modules.filter((m) => m !== key) : [...prev.modules, key];
      if (key === "PHARMACY" && !mods.includes("PHARMACY")) mods = mods.filter((m) => m !== "MAGISTRAL");
      return { ...prev, modules: mods };
    });
  };

  const checkRuc = () => {
    if (props.mode !== "create" || v.ruc.length !== 11) return;
    startTransition(async () => {
      const res = await validateRucAction(v.ruc);
      if (!res.ok) {
        setRucInfo({ tone: "bad", text: res.error.message });
        return;
      }
      if ("checksumOnly" in res.data) {
        setRucInfo({ tone: "ok", text: "RUC válido (dígito verificador). Complete los datos manualmente." });
        return;
      }
      const info = res.data;
      setV((prev) => ({
        ...prev,
        legalName: prev.legalName || info.razonSocial,
        fiscalAddress: prev.fiscalAddress || info.direccion,
        ubigeo: prev.ubigeo || info.ubigeo,
        department: prev.department || info.departamento,
        province: prev.province || info.provincia,
        district: prev.district || info.distrito,
      }));
      setRucInfo({ tone: "ok", text: `${info.estado} · ${info.condicion}${info.warnings.length ? ` · ${info.warnings.join(" ")}` : ""}` });
    });
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setErrors({});
    setFormError(null);
    setNotice(null);
    startTransition(async () => {
      if (props.mode === "create") {
        const res = await createTenantAction({
          ruc: v.ruc, legalName: v.legalName, tradeName: v.tradeName || undefined, fiscalAddress: v.fiscalAddress,
          ubigeo: v.ubigeo, department: v.department, province: v.province, district: v.district,
          slug, businessLines: v.businessLines, planId, contactName: v.contactName, contactEmail: v.contactEmail,
          contactPhone: v.contactPhone || undefined, adminEmail: adminEmail || v.contactEmail,
          adminFullName: adminFullName || v.contactName, modules: v.modules,
        });
        if (!res.ok) {
          setErrors(res.error.fieldErrors ?? {});
          setFormError(res.error.message);
          return;
        }
        router.push(`/superadmin/tenants/${res.data.tenantId}?created=1`);
        return;
      }

      const res = await updateTenantAction({
        tenantId: props.tenantId, legalName: v.legalName, tradeName: v.tradeName || undefined,
        fiscalAddress: v.fiscalAddress, ubigeo: v.ubigeo, department: v.department, province: v.province,
        district: v.district, contactName: v.contactName, contactEmail: v.contactEmail,
        contactPhone: v.contactPhone || undefined, businessLines: v.businessLines,
      });
      if (!res.ok) {
        setErrors(res.error.fieldErrors ?? {});
        setFormError(res.error.message);
        return;
      }
      const initialMods = [...props.initial.modules].sort().join();
      if ([...v.modules].sort().join() !== initialMods) {
        const mods = await run(() => setModulesAction({ tenantId: props.tenantId, modules: v.modules }));
        if (!mods.ok) {
          setFormError(`Datos guardados, pero los módulos no: ${mods.error.message}`);
          return;
        }
      }
      setNotice("Cambios guardados.");
      router.refresh();
    });
  };

  const err = (k: string) => errors[k]?.[0];
  const field = (
    k: keyof TenantFormValues, label: string,
    opts: { required?: boolean; type?: string; hint?: string; wide?: boolean; maxLength?: number; pattern?: string; disabled?: boolean; onBlur?: () => void } = {},
  ) => (
    <label className={`field${opts.wide ? " wide" : ""}`}>
      <span>{label}{opts.required && " *"}</span>
      <input
        type={opts.type ?? "text"} value={String(v[k])} required={opts.required} maxLength={opts.maxLength}
        pattern={opts.pattern} disabled={opts.disabled || pending} onBlur={opts.onBlur}
        onChange={(e) => set(k, e.target.value as never)} aria-invalid={!!err(k)}
      />
      {opts.hint && <span className="hint">{opts.hint}</span>}
      {err(k) && <span className="error">{err(k)}</span>}
    </label>
  );

  return (
    <form onSubmit={submit} noValidate={false}>
      {dialog}
      {formError && <p className="alert" role="alert">{formError}</p>}
      {notice && <p className="success" role="status">{notice}</p>}

      <section className="card">
        <h2>Datos fiscales</h2>
        <div className="grid">
          {field("ruc", "RUC", {
            required: true, maxLength: 11, pattern: "\\d{11}", disabled: props.mode === "edit", onBlur: checkRuc,
            hint: props.mode === "edit" ? "El RUC no se modifica: identifica al emisor de los comprobantes." : "Se valida el dígito verificador al salir del campo.",
          })}
          {field("legalName", "Razón social", { required: true })}
          {field("tradeName", "Nombre comercial")}
          {field("fiscalAddress", "Dirección fiscal", { required: true, wide: true })}
          {field("ubigeo", "Ubigeo", { required: true, maxLength: 6, pattern: "\\d{6}", hint: "6 dígitos INEI, ej. 150101 (Lima)" })}
          {field("department", "Departamento", { required: true })}
          {field("province", "Provincia", { required: true })}
          {field("district", "Distrito", { required: true })}
        </div>
        {rucInfo && <p className={rucInfo.tone === "ok" ? "success" : "alert"} style={{ marginTop: 12 }}>{rucInfo.text}</p>}
      </section>

      <section className="card">
        <h2>Contacto</h2>
        <div className="grid">
          {field("contactName", "Nombre de contacto", { required: true })}
          {field("contactEmail", "Email", { required: true, type: "email" })}
          {field("contactPhone", "Teléfono", { type: "tel" })}
        </div>
        {props.mode === "create" && (
          <>
            <h2 style={{ marginTop: 20 }}>Administrador del negocio</h2>
            <p className="muted">Recibirá un correo de invitación para crear su contraseña. Si lo deja vacío se usa el contacto.</p>
            <div className="grid">
              <label className="field">
                <span>Email del administrador</span>
                <input type="email" value={adminEmail} placeholder={v.contactEmail} onChange={(e) => setAdminEmail(e.target.value)} disabled={pending} />
                {err("adminEmail") && <span className="error">{err("adminEmail")}</span>}
              </label>
              <label className="field">
                <span>Nombre del administrador</span>
                <input value={adminFullName} placeholder={v.contactName} onChange={(e) => setAdminFullName(e.target.value)} disabled={pending} />
              </label>
            </div>
          </>
        )}
      </section>

      <section className="card">
        <h2>Rubros y módulos</h2>
        {props.mode === "create" && (
          <div className="grid" style={{ marginBottom: 16 }}>
            <label className="field">
              <span>Plan *</span>
              <select
                value={planId} required disabled={pending}
                onChange={(e) => {
                  setPlanId(e.target.value);
                  applySuggestion(v.businessLines, plans.find((p) => p.id === e.target.value)?.includedModules ?? []);
                }}
              >
                {plans.map((p) => <option key={p.id} value={p.id}>{p.name} — S/ {p.monthlyPrice}/mes</option>)}
              </select>
              <span className="hint">Inicia en periodo de prueba y ambiente SUNAT beta.</span>
            </label>
            <label className="field">
              <span>Identificador</span>
              <input value={slug} readOnly aria-readonly />
              <span className="hint">Se genera del nombre y el RUC.</span>
            </label>
          </div>
        )}

        <p className="muted" style={{ margin: "0 0 8px" }}>Rubros del negocio *</p>
        <div className="checks" style={{ marginBottom: 16 }}>
          {BUSINESS_LINES.map((l) => (
            <label key={l.key} className="check">
              <input type="checkbox" checked={v.businessLines.includes(l.key)} onChange={() => toggleLine(l.key)} disabled={pending} />
              <span>{l.label}</span>
            </label>
          ))}
        </div>
        {err("businessLines") && <p className="error">Seleccione al menos un rubro.</p>}

        <p className="muted" style={{ margin: "0 0 8px" }}>Módulos activos</p>
        <div className="checks">
          {MODULES.map((m) => {
            const needs = "requires" in m ? m.requires : undefined;
            const blocked = ("locked" in m && m.locked) || (needs !== undefined && !v.modules.includes(needs));
            return (
              <label key={m.key} className={`check${blocked ? " disabled" : ""}`}>
                <input type="checkbox" checked={v.modules.includes(m.key)} onChange={() => toggleModule(m.key)} disabled={blocked || pending} />
                <span>{m.label}<small>{m.hint}</small></span>
              </label>
            );
          })}
        </div>
      </section>

      <div className="actions">
        <a className="btn" href="/superadmin">Cancelar</a>
        <button type="submit" className="btn primary" disabled={pending || (props.mode === "create" && v.businessLines.length === 0)}>
          {pending ? "Guardando…" : props.mode === "create" ? "Registrar cliente" : "Guardar cambios"}
        </button>
      </div>
    </form>
  );
}
