"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { WhatsappStatus } from "@/lib/whatsapp/settings";
import type { BridgeState } from "@/lib/whatsapp/bridge";
import type { ReminderScan } from "@/lib/whatsapp/reminders";
import { Panel } from "../../_components/ui";
import { bridgeStateAction, runRemindersAction, saveWhatsappAction, testWhatsappAction } from "./actions";

type Msg = { tone: "ok" | "bad"; text: string } | null;

/** QR real entregado por el puente. Se refresca porque WhatsApp rota el código cada pocos segundos. */
function QrPanel({ active }: { active: boolean }) {
  const [state, setState] = useState<BridgeState | null>(null);
  useEffect(() => {
    if (!active) return;
    let stop = false;
    const tick = async () => {
      const r = await bridgeStateAction();
      if (!stop && r.ok) setState(r.data);
    };
    void tick();
    const id = setInterval(() => void tick(), 15_000);
    return () => { stop = true; clearInterval(id); };
  }, [active]);

  if (!state) return <p className="app-muted set-pad">Consultando el servicio…</p>;
  if (state.status === "connected") return <p className="set-msg ok" style={{ margin: 20 }} role="status">WhatsApp conectado.</p>;
  if (state.status === "qr") {
    return (
      <div className="wa-qr">
        <div className="wa-qr-code" dangerouslySetInnerHTML={{ __html: state.svg }} />
        <ol>
          <li>Abra WhatsApp en el teléfono del negocio.</li>
          <li>Vaya a Dispositivos vinculados → Vincular un dispositivo.</li>
          <li>Escanee este código.</li>
        </ol>
      </div>
    );
  }
  return (
    <p className="set-msg bad" style={{ margin: 20 }} role="status">
      {state.status === "unavailable"
        ? "El servicio de WhatsApp Web no está instalado en esta plataforma, así que no hay código que escanear. Use Meta Cloud API o solicite el servicio a soporte."
        : "El servicio de WhatsApp Web no responde. Intente en unos minutos."}
    </p>
  );
}

export function WhatsappSettings({ status }: { status: WhatsappStatus }) {
  const router = useRouter();
  const [provider, setProvider] = useState(status.provider);
  const [wabaId, setWabaId] = useState(status.wabaId);
  const [phoneNumberId, setPhoneNumberId] = useState(status.phoneNumberId);
  const [token, setToken] = useState("");
  const [enabled, setEnabled] = useState(status.enabled);
  const [days, setDays] = useState(String(status.reminderDays));
  const [alertPhone, setAlertPhone] = useState(status.alertPhone);
  const [msg, setMsg] = useState<Msg>(null);
  const [scan, setScan] = useState<ReminderScan | null>(null);
  const [pending, start] = useTransition();

  const fail = (r: { error: { message: string; fieldErrors?: Record<string, string[]> } }) =>
    setMsg({ tone: "bad", text: r.error.fieldErrors ? Object.values(r.error.fieldErrors).flat()[0] ?? r.error.message : r.error.message });

  function save(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    start(async () => {
      const r = await saveWhatsappAction({ provider, wabaId, phoneNumberId, token: token || undefined, enabled, reminderDays: Number(days) || 3, alertPhone: alertPhone || undefined });
      if (!r.ok) return fail(r);
      setToken("");
      setMsg({ tone: "ok", text: "Configuración guardada. El token se guardó cifrado." });
      router.refresh();
    });
  }
  const test = () => start(async () => {
    setMsg(null);
    const r = await testWhatsappAction();
    if (!r.ok) return fail(r);
    setMsg({ tone: "ok", text: `Conexión correcta: ${r.data.name} (${r.data.phone}).` });
  });
  const run = (dry: boolean) => start(async () => {
    setMsg(null);
    const r = await runRemindersAction(dry);
    if (!r.ok) return fail(r);
    setScan(r.data);
    if (!dry) setMsg({ tone: "ok", text: `${r.data.queued} recordatorio(s) encolados para envío.` });
  });

  return (
    <div className="app-stack">
      <Panel title="Conexión">
        <form onSubmit={save}>
          <div className="wa-providers" role="radiogroup" aria-label="Proveedor de WhatsApp">
            {([["META_CLOUD", "Meta Cloud API", "API oficial de WhatsApp Business. Recomendada para producción."], ["WEB_QR", "Web QR Local", "Vincula un teléfono escaneando un código. No es un canal oficial de Meta: el número puede ser restringido."]] as const).map(([k, title, text]) => (
              <button key={k} type="button" role="radio" aria-checked={provider === k} className={`wa-provider${provider === k ? " on" : ""}`} onClick={() => { setProvider(k); setMsg(null); }}>
                <strong>{title}</strong><small>{text}</small>
              </button>
            ))}
          </div>

          {provider === "META_CLOUD" ? (
            <div className="set-form">
              <label className="set-field"><span>WABA ID *</span><input inputMode="numeric" value={wabaId} onChange={(e) => setWabaId(e.target.value.trim())} /></label>
              <label className="set-field"><span>Phone Number ID *</span><input inputMode="numeric" value={phoneNumberId} onChange={(e) => setPhoneNumberId(e.target.value.trim())} /><small>Meta envía los mensajes desde este identificador.</small></label>
              <label className="set-field wide"><span>Token de acceso {status.tokenMask ? "" : "*"}</span>
                <input type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} placeholder={status.tokenMask ? `Guardado (${status.tokenMask}). Déjelo vacío para conservarlo` : "Pegue el token de acceso"} />
                <small>Se guarda cifrado (AES-256-GCM) y nunca vuelve a mostrarse.</small></label>
            </div>
          ) : <QrPanel active />}

          <div className="set-form" style={{ paddingTop: 0 }}>
            <label className="set-field"><span>Días de anticipación</span><input inputMode="numeric" maxLength={2} value={days} onChange={(e) => setDays(e.target.value.replace(/\D/g, ""))} /></label>
            <label className="set-field"><span>Teléfono para alertas de caducidad</span><input inputMode="tel" value={alertPhone} onChange={(e) => setAlertPhone(e.target.value)} placeholder="Si lo deja vacío, se usa el del negocio" /></label>
            <label className="set-check wide"><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Enviar recordatorios automáticos por WhatsApp</label>
          </div>
          {msg && <p className={`set-msg ${msg.tone}`} role={msg.tone === "bad" ? "alert" : "status"} style={{ margin: "0 20px 14px" }}>{msg.text}</p>}
          <div className="rx-actions set-pad">
            {provider === "META_CLOUD" && status.tokenMask && <button type="button" className="app-btn" disabled={pending} onClick={test}>Probar conexión</button>}
            <button type="submit" className="app-btn primary" disabled={pending}>{pending ? "Guardando…" : "Guardar"}</button>
          </div>
        </form>
      </Panel>

      <Panel title="Recordatorios automáticos">
        <p className="app-muted set-pad">
          Vacunas a los propietarios y lotes por vencer al negocio, {status.reminderDays} día(s) antes. Cada aviso se envía una sola vez.
          En Meta, los mensajes usan las plantillas <code>recordatorio_vacuna</code> y <code>alerta_caducidad</code>, que deben estar aprobadas en su cuenta.
        </p>
        <div className="rx-actions set-pad">
          <button type="button" className="app-btn" disabled={pending} onClick={() => run(true)}>Simular (no envía nada)</button>
          <button type="button" className="app-btn primary" disabled={pending || !status.enabled} onClick={() => run(false)}>Ejecutar ahora</button>
        </div>
        {scan && (
          scan.tenants === 0 ? <p className="app-muted set-pad">Active los recordatorios y el módulo WhatsApp para ejecutar esta tarea.</p>
          : scan.items.length === 0 ? <p className="app-muted set-pad">No hay vacunas ni lotes por avisar en este plazo.</p>
          : (
            <div className="app-table-wrap"><table className="app-table stack">
              <thead><tr><th>Aviso</th><th>Destinatario</th><th>Mensaje</th><th>Estado</th></tr></thead>
              <tbody>{scan.items.map((i) => (
                <tr key={`${i.kind}-${i.label}-${i.recipient}`}>
                  <td data-label="Aviso"><strong>{i.label}</strong></td>
                  <td data-label="Destinatario">{i.recipient}</td>
                  <td data-label="Mensaje">{i.text}</td>
                  <td data-label="Estado"><span className={`app-pill ${i.isNew ? "blue" : "gray"}`}>{i.isNew ? (scan.dryRun ? "Se enviaría" : "Encolado") : "Ya enviado"}</span></td>
                </tr>
              ))}</tbody>
            </table></div>
          )
        )}
      </Panel>
    </div>
  );
}
