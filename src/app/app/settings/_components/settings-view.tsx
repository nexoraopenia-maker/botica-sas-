"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { ActionResult } from "@/lib/result";
import {
  createBranchAction, createSeriesAction, saveAlertRuleAction, toggleSeriesAction, updateBranchAction,
} from "../actions";

export interface BranchView { id: string; sunatCode: string; name: string; address: string; ubigeo: string; phone: string; isActive: boolean }
export interface SeriesView { id: string; branchId: string; docType: DocType; series: string; lastNumber: number; isActive: boolean }
export interface AlertRuleView {
  kind: "BATCH_EXPIRY" | "LOW_STOCK" | "VACCINE_DUE" | "CERTIFICATE_EXPIRY";
  enabled: boolean;
  thresholds: number[];
  channels: ("IN_APP" | "EMAIL" | "WHATSAPP")[];
  recipientRoles: string[];
}
type DocType = "FACTURA" | "BOLETA" | "NOTA_CREDITO" | "NOTA_DEBITO";
type Tab = "branches" | "series" | "alerts";

const DOC_LABEL: Record<DocType, string> = { FACTURA: "Factura", BOLETA: "Boleta", NOTA_CREDITO: "Nota de crédito", NOTA_DEBITO: "Nota de débito" };
const DOC_HINT: Record<DocType, string> = { FACTURA: "F002", BOLETA: "B002", NOTA_CREDITO: "FC02 / BC02", NOTA_DEBITO: "FD02 / BD02" };
const ALERT_INFO: Record<AlertRuleView["kind"], { title: string; text: string; unit: string | null }> = {
  BATCH_EXPIRY: { title: "Caducidad de lotes", text: "Avisa cuando un lote con stock entra en cada umbral de días antes de vencer (0 = vencido).", unit: "días antes del vencimiento" },
  LOW_STOCK: { title: "Stock mínimo", text: "Avisa (una vez por semana) cuando el stock vendible de un producto llega a su mínimo configurado.", unit: null },
  VACCINE_DUE: { title: "Recordatorios de vacunas", text: "Recuerda al propietario la próxima vacuna de su mascota.", unit: "días antes de la fecha (0 = el mismo día)" },
  CERTIFICATE_EXPIRY: { title: "Certificado digital", text: "Avisa antes de que venza el certificado con el que se firman los comprobantes.", unit: "días antes del vencimiento" },
};
const CHANNELS = [
  { key: "IN_APP", label: "En la app" },
  { key: "EMAIL", label: "Email" },
  { key: "WHATSAPP", label: "WhatsApp" },
] as const;

function useMutation() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const run = <T,>(fn: () => Promise<ActionResult<T>>, success: string, after?: () => void) =>
    start(async () => {
      setMsg(null);
      const res = await fn();
      if (!res.ok) {
        const field = res.error.fieldErrors ? Object.values(res.error.fieldErrors).flat()[0] : undefined;
        setMsg({ tone: "bad", text: field ?? res.error.message });
        return;
      }
      setMsg({ tone: "ok", text: success });
      after?.();
      router.refresh();
    });
  const banner = msg ? <p className={`set-msg ${msg.tone}`} role={msg.tone === "bad" ? "alert" : "status"}>{msg.text}</p> : null;
  return { pending, run, banner };
}

export function SettingsView(props: {
  initialTab: Tab;
  branches: BranchView[];
  series: SeriesView[];
  rules: AlertRuleView[];
  roles: { key: string; name: string }[];
  maxBranches: number;
  whatsappEnabled: boolean;
}) {
  const [tab, setTab] = useState<Tab>(props.initialTab);
  const select = (t: Tab) => {
    setTab(t);
    window.history.replaceState(null, "", `?tab=${t}`); // pestaña en la URL sin recargar
  };
  return (
    <>
      <div className="set-tabs" role="tablist" aria-label="Secciones de configuración">
        {([["branches", "Sucursales"], ["series", "Series de comprobantes"], ["alerts", "Alertas"]] as const).map(([k, label]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? "on" : ""} onClick={() => select(k)}>{label}</button>
        ))}
      </div>
      {tab === "branches" && <Branches branches={props.branches} maxBranches={props.maxBranches} />}
      {tab === "series" && <Series branches={props.branches} series={props.series} />}
      {tab === "alerts" && <Alerts rules={props.rules} roles={props.roles} whatsappEnabled={props.whatsappEnabled} />}
    </>
  );
}

// ───────────────────────────── Sucursales ─────────────────────────────

function Branches({ branches, maxBranches }: { branches: BranchView[]; maxBranches: number }) {
  const { pending, run, banner } = useMutation();
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState({ sunatCode: "", name: "", address: "", ubigeo: "", phone: "" });
  const active = branches.filter((b) => b.isActive).length;
  const canAdd = active < maxBranches;

  return (
    <div className="app-stack">
      {banner}
      <section className="app-panel">
        <header className="app-panel-head">
          <h2>Sucursales ({active} de {maxBranches} activas en su plan)</h2>
        </header>
        <div className="set-list">
          {branches.map((b) => editing === b.id
            ? <BranchEditor key={b.id} branch={b} pending={pending} onCancel={() => setEditing(null)}
                onSave={(v) => run(() => updateBranchAction({ branchId: b.id, ...v, phone: v.phone || undefined }), "Sucursal actualizada.", () => setEditing(null))} />
            : (
              <div key={b.id} className="set-row">
                <div>
                  <strong>{b.name}</strong> <span className={`app-pill ${b.isActive ? "green" : "gray"}`}>{b.isActive ? "Activa" : "Inactiva"}</span>
                  <span className="app-sub">Establecimiento SUNAT {b.sunatCode} · {b.address} · Ubigeo {b.ubigeo}{b.phone ? ` · ${b.phone}` : ""}</span>
                </div>
                <button type="button" className="app-btn" onClick={() => setEditing(b.id)}>Editar</button>
              </div>
            ))}
        </div>
      </section>

      <section className="app-panel">
        <header className="app-panel-head"><h2>Nueva sucursal</h2></header>
        {!canAdd ? (
          <p className="app-muted set-pad">Alcanzó el límite de sucursales activas de su plan. Desactive una o contacte a soporte para ampliarlo.</p>
        ) : (
          <form className="set-form" onSubmit={(e) => {
            e.preventDefault();
            run(() => createBranchAction({ ...form, phone: form.phone || undefined }), "Sucursal creada. Agregue sus series en la pestaña «Series».",
              () => setForm({ sunatCode: "", name: "", address: "", ubigeo: "", phone: "" }));
          }}>
            <label className="set-field"><span>Código SUNAT *</span>
              <input required inputMode="numeric" maxLength={4} pattern="\d{4}" placeholder="0001" value={form.sunatCode}
                onChange={(e) => setForm({ ...form, sunatCode: e.target.value.replace(/\D/g, "") })} />
              <small>Código del establecimiento anexo registrado en SUNAT.</small>
            </label>
            <label className="set-field"><span>Nombre *</span>
              <input required value={form.name} placeholder="Sucursal Centro" onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
            <label className="set-field wide"><span>Dirección *</span>
              <input required value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} /></label>
            <label className="set-field"><span>Ubigeo *</span>
              <input required inputMode="numeric" maxLength={6} pattern="\d{6}" placeholder="150101" value={form.ubigeo}
                onChange={(e) => setForm({ ...form, ubigeo: e.target.value.replace(/\D/g, "") })} /></label>
            <label className="set-field"><span>Teléfono</span>
              <input type="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></label>
            <div className="set-actions"><button className="app-btn primary" disabled={pending}>{pending ? "Guardando…" : "Crear sucursal"}</button></div>
          </form>
        )}
      </section>
    </div>
  );
}

function BranchEditor({ branch, pending, onSave, onCancel }: {
  branch: BranchView; pending: boolean;
  onSave: (v: { name: string; address: string; ubigeo: string; phone: string; isActive: boolean }) => void; onCancel: () => void;
}) {
  const [v, setV] = useState({ name: branch.name, address: branch.address, ubigeo: branch.ubigeo, phone: branch.phone, isActive: branch.isActive });
  return (
    <form className="set-form set-edit" onSubmit={(e) => { e.preventDefault(); onSave(v); }}>
      <label className="set-field"><span>Código SUNAT</span><input value={branch.sunatCode} disabled />
        <small>No se modifica: identifica al establecimiento en los comprobantes emitidos.</small></label>
      <label className="set-field"><span>Nombre *</span><input required value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} /></label>
      <label className="set-field wide"><span>Dirección *</span><input required value={v.address} onChange={(e) => setV({ ...v, address: e.target.value })} /></label>
      <label className="set-field"><span>Ubigeo *</span><input required maxLength={6} pattern="\d{6}" value={v.ubigeo} onChange={(e) => setV({ ...v, ubigeo: e.target.value.replace(/\D/g, "") })} /></label>
      <label className="set-field"><span>Teléfono</span><input value={v.phone} onChange={(e) => setV({ ...v, phone: e.target.value })} /></label>
      <label className="set-check"><input type="checkbox" checked={v.isActive} onChange={(e) => setV({ ...v, isActive: e.target.checked })} /> Sucursal activa</label>
      <div className="set-actions">
        <button type="button" className="app-btn" onClick={onCancel} disabled={pending}>Cancelar</button>
        <button className="app-btn primary" disabled={pending}>{pending ? "Guardando…" : "Guardar"}</button>
      </div>
    </form>
  );
}

// ───────────────────────────── Series ─────────────────────────────

function Series({ branches, series }: { branches: BranchView[]; series: SeriesView[] }) {
  const { pending, run, banner } = useMutation();
  const [form, setForm] = useState<{ branchId: string; docType: DocType; series: string }>({ branchId: branches[0]?.id ?? "", docType: "BOLETA", series: "" });

  return (
    <div className="app-stack">
      {banner}
      {branches.map((b) => {
        const rows = series.filter((s) => s.branchId === b.id);
        return (
          <section key={b.id} className="app-panel">
            <header className="app-panel-head"><h2>{b.name} <span className="app-sub" style={{ display: "inline" }}>· establecimiento {b.sunatCode}</span></h2></header>
            {rows.length === 0 ? <p className="app-muted set-pad">Sin series. Cree al menos una de boleta y una de factura para vender desde esta sucursal.</p> : (
              <div className="app-table-wrap"><table className="app-table stack">
                <thead><tr><th>Serie</th><th>Tipo</th><th className="num">Último número</th><th>Estado</th><th aria-label="Acciones" /></tr></thead>
                <tbody>{rows.map((s) => (
                  <tr key={s.id}>
                    <td data-label="Serie"><strong>{s.series}</strong></td>
                    <td data-label="Tipo">{DOC_LABEL[s.docType]}</td>
                    <td data-label="Último número" className="num">{s.lastNumber}</td>
                    <td data-label="Estado"><span className={`app-pill ${s.isActive ? "green" : "gray"}`}>{s.isActive ? "Activa" : "Inactiva"}</span></td>
                    <td data-label="">
                      <button type="button" className="app-btn" disabled={pending}
                        onClick={() => run(() => toggleSeriesAction({ seriesId: s.id, isActive: !s.isActive }), s.isActive ? `Serie ${s.series} desactivada.` : `Serie ${s.series} activada.`)}>
                        {s.isActive ? "Desactivar" : "Activar"}
                      </button>
                    </td>
                  </tr>
                ))}</tbody>
              </table></div>
            )}
          </section>
        );
      })}

      <section className="app-panel">
        <header className="app-panel-head"><h2>Nueva serie</h2></header>
        <form className="set-form" onSubmit={(e) => {
          e.preventDefault();
          run(() => createSeriesAction(form), `Serie ${form.series.toUpperCase()} creada.`, () => setForm({ ...form, series: "" }));
        }}>
          <label className="set-field"><span>Sucursal *</span>
            <select value={form.branchId} onChange={(e) => setForm({ ...form, branchId: e.target.value })}>
              {branches.map((b) => <option key={b.id} value={b.id}>{b.name} ({b.sunatCode})</option>)}
            </select></label>
          <label className="set-field"><span>Tipo de comprobante *</span>
            <select value={form.docType} onChange={(e) => setForm({ ...form, docType: e.target.value as DocType })}>
              {(Object.keys(DOC_LABEL) as DocType[]).map((d) => <option key={d} value={d}>{DOC_LABEL[d]}</option>)}
            </select></label>
          <label className="set-field"><span>Serie *</span>
            <input required maxLength={4} placeholder={DOC_HINT[form.docType]} value={form.series}
              onChange={(e) => setForm({ ...form, series: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "") })} />
            <small>4 caracteres. Factura y sus notas inician con F; boleta y sus notas con B.</small></label>
          <div className="set-actions"><button className="app-btn primary" disabled={pending || form.series.length !== 4}>{pending ? "Guardando…" : "Crear serie"}</button></div>
        </form>
        <p className="app-muted set-pad">El correlativo empieza en 1 y avanza solo con cada comprobante; no se puede editar para evitar huecos o duplicados ante SUNAT.</p>
      </section>
    </div>
  );
}

// ───────────────────────────── Alertas ─────────────────────────────

function Alerts({ rules, roles, whatsappEnabled }: { rules: AlertRuleView[]; roles: { key: string; name: string }[]; whatsappEnabled: boolean }) {
  return (
    <div className="app-stack">
      {rules.map((r) => <AlertRuleEditor key={r.kind} rule={r} roles={roles} whatsappEnabled={whatsappEnabled} />)}
    </div>
  );
}

function AlertRuleEditor({ rule, roles, whatsappEnabled }: { rule: AlertRuleView; roles: { key: string; name: string }[]; whatsappEnabled: boolean }) {
  const { pending, run, banner } = useMutation();
  const info = ALERT_INFO[rule.kind];
  const [enabled, setEnabled] = useState(rule.enabled);
  const [thresholds, setThresholds] = useState(rule.thresholds.join(", "));
  // Sin módulo WhatsApp, ese canal no se puede guardar: se descarta del valor inicial
  const [channels, setChannels] = useState(rule.channels.filter((c) => c !== "WHATSAPP" || whatsappEnabled));
  const [recipients, setRecipients] = useState(rule.recipientRoles);
  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const parsed = thresholds.split(/[,\s]+/).filter(Boolean).map(Number);
  const invalid = parsed.some((n) => !Number.isInteger(n) || n < 0 || n > 365);
  const isVaccine = rule.kind === "VACCINE_DUE";

  return (
    <section className="app-panel">
      <header className="app-panel-head">
        <div><h2>{info.title}</h2><span className="app-sub">{info.text}</span></div>
        <label className="set-switch">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          <span>{enabled ? "Activa" : "Desactivada"}</span>
        </label>
      </header>
      <form className="set-form" onSubmit={(e) => {
        e.preventDefault();
        run(() => saveAlertRuleAction({ kind: rule.kind, enabled, thresholds: info.unit ? parsed : [], channels, recipientRoles: isVaccine ? [] : recipients }), "Alerta guardada.");
      }}>
        {banner && <div className="wide">{banner}</div>}
        {info.unit && (
          <label className="set-field wide"><span>Umbrales ({info.unit})</span>
            <input value={thresholds} onChange={(e) => setThresholds(e.target.value)} placeholder="90, 60, 30, 15, 7, 0" aria-invalid={invalid} />
            {invalid ? <small className="bad">Use números enteros entre 0 y 365 separados por comas.</small> : <small>Separados por comas.</small>}
          </label>
        )}
        <fieldset className="set-field wide"><legend>Canales</legend>
          <div className="set-chips">
            {CHANNELS.filter((c) => c.key !== "WHATSAPP" || whatsappEnabled || isVaccine).map((c) => {
              const disabled = c.key === "WHATSAPP" && !whatsappEnabled;
              return (
                <label key={c.key} className={`set-chip${channels.includes(c.key) ? " on" : ""}${disabled ? " off" : ""}`}
                  title={disabled ? "Requiere el módulo WhatsApp" : undefined}>
                  <input type="checkbox" checked={channels.includes(c.key)} disabled={disabled} onChange={() => setChannels(toggle(channels, c.key))} />
                  {c.label}
                </label>
              );
            })}
          </div>
          {isVaccine && <small>Se envía al propietario de la mascota (según sus datos de contacto y consentimiento).</small>}
        </fieldset>
        {!isVaccine && (
          <fieldset className="set-field wide"><legend>Quién recibe la alerta</legend>
            <div className="set-chips">
              {roles.map((r) => (
                <label key={r.key} className={`set-chip${recipients.includes(r.key) ? " on" : ""}`}>
                  <input type="checkbox" checked={recipients.includes(r.key)} onChange={() => setRecipients(toggle(recipients, r.key))} />
                  {r.name}
                </label>
              ))}
            </div>
          </fieldset>
        )}
        <div className="set-actions"><button className="app-btn primary" disabled={pending || invalid || channels.length === 0}>{pending ? "Guardando…" : "Guardar"}</button></div>
      </form>
    </section>
  );
}
