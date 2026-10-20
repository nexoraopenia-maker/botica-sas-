"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { SunatStatus } from "@/lib/settings/sunat";
import type { ActionResult } from "@/lib/result";
import { saveSolAction, setSunatEnvAction, testBetaAction, updateLegalNameAction, uploadCertificateAction } from "../actions";

const OUTCOME: Record<string, { tone: "ok" | "bad"; text: string }> = {
  ACCEPTED: { tone: "ok", text: "SUNAT beta aceptó la boleta de prueba firmada con su certificado. Con la clave SOL guardada, ya puede pasar a producción." },
  ACCEPTED_WITH_OBS: { tone: "ok", text: "SUNAT beta aceptó la boleta de prueba (con observaciones)." },
  REJECTED: { tone: "bad", text: "SUNAT rechazó la boleta de prueba" },
  CONFIG_ERROR: { tone: "bad", text: "Error de credenciales o certificado" },
  RETRYABLE: { tone: "bad", text: "SUNAT no respondió (servicio no disponible). Intente nuevamente" },
  EXCEPTION: { tone: "bad", text: "SUNAT devolvió una excepción" },
  ALREADY_REGISTERED: { tone: "bad", text: "SUNAT indica que ya estaba registrado" },
};

const fmtDate = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("es-PE", { timeZone: "America/Lima", day: "2-digit", month: "short", year: "numeric" }) : "—");
const daysLeft = (iso: string | null) => (iso ? Math.floor((new Date(iso).getTime() - Date.now()) / 86_400_000) : null);

export function SunatSettings({ status }: { status: SunatStatus }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const [legalName, setLegalName] = useState(status.legalName);
  const [solUser, setSolUser] = useState("");
  const [solPass, setSolPass] = useState("");
  const [certPass, setCertPass] = useState("");
  const [certFile, setCertFile] = useState<File | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const run = <T,>(fn: () => Promise<ActionResult<T>>, ok: (d: T) => string, after?: () => void) =>
    start(async () => {
      setMsg(null);
      const res = await fn();
      if (!res.ok) {
        const field = res.error.fieldErrors ? Object.values(res.error.fieldErrors).flat()[0] : undefined;
        setMsg({ tone: "bad", text: field ?? res.error.message });
        return;
      }
      setMsg({ tone: "ok", text: ok(res.data) });
      after?.();
      router.refresh();
      window.scrollTo({ top: 0, behavior: "smooth" });
    });

  const certDays = daysLeft(status.certificate?.notAfter ?? null);
  const prod = status.env === "PRODUCTION";

  return (
    <div className="app-stack">
      {msg && <p className={`set-msg ${msg.tone}`} role={msg.tone === "bad" ? "alert" : "status"}>{msg.text}</p>}

      <section className="app-panel">
        <header className="app-panel-head"><h2>Estado de la facturación electrónica</h2>
          <span className={`app-pill ${prod ? "green" : "amber"}`}>{prod ? "Producción" : "Beta (pruebas)"}</span></header>
        <div className="sun-status">
          <div className="sun-item">
            <span className={`sun-dot ${status.certificate && (certDays ?? -1) >= 0 ? (certDays! <= 30 ? "warn" : "ok") : "bad"}`} aria-hidden />
            <div><strong>Certificado digital</strong>
              <span className="app-sub">{status.certificate ? `Vence ${fmtDate(status.certificate.notAfter)}${certDays !== null ? ` (${certDays < 0 ? "vencido" : `${certDays} días`})` : ""}` : "No cargado"}</span></div>
          </div>
          <div className="sun-item">
            <span className={`sun-dot ${status.solUserMask ? "ok" : "bad"}`} aria-hidden />
            <div><strong>Clave SOL</strong><span className="app-sub">{status.solUserMask ? `Usuario ${status.solUserMask} · ${fmtDate(status.solUpdatedAt)}` : "No configurada"}</span></div>
          </div>
          <div className="sun-item">
            <span className={`sun-dot ${status.betaPassedAt ? "ok" : "bad"}`} aria-hidden />
            <div><strong>Prueba en beta</strong><span className="app-sub">{status.betaPassedAt ? `Aprobada ${fmtDate(status.betaPassedAt)}` : "Pendiente"}</span></div>
          </div>
        </div>
        <p className="app-muted set-pad sun-lock">
          🔒 La clave SOL y el certificado se cifran con AES-256-GCM (llave por secreto, envuelta con la llave maestra del servidor y atada a su negocio) antes de guardarse. Nunca se muestran ni salen del servidor; solo se descifran en memoria al firmar y enviar cada comprobante.
        </p>
      </section>

      <section className="app-panel">
        <header className="app-panel-head"><h2>Datos del emisor</h2></header>
        <form className="set-form" onSubmit={(e) => { e.preventDefault(); run(() => updateLegalNameAction({ legalName }), () => "Razón social actualizada."); }}>
          <label className="set-field"><span>RUC</span><input value={status.ruc} disabled />
            <small>Identifica al emisor de sus comprobantes; no se modifica. Si es incorrecto, contacte a soporte.</small></label>
          <label className="set-field wide"><span>Razón social *</span>
            <input required minLength={3} value={legalName} onChange={(e) => setLegalName(e.target.value)} />
            <small>Debe ser idéntica a la registrada en SUNAT: aparece en cada comprobante.</small></label>
          <div className="set-actions"><button className="app-btn" disabled={pending || legalName.trim().toUpperCase() === status.legalName}>Guardar razón social</button></div>
        </form>
      </section>

      <section className="app-panel">
        <header className="app-panel-head"><h2>Credenciales SOL</h2><span className="app-sub">Usuario secundario creado en SUNAT Operaciones en Línea</span></header>
        <form className="set-form" autoComplete="off" onSubmit={(e) => {
          e.preventDefault();
          run(() => saveSolAction({ user: solUser, password: solPass }), () => "Credenciales SOL cifradas y guardadas.", () => { setSolUser(""); setSolPass(""); });
        }}>
          <label className="set-field"><span>Usuario SOL *</span>
            <input required value={solUser} onChange={(e) => setSolUser(e.target.value.toUpperCase())} placeholder={status.solUserMask ?? "Ej. FACTURA1"} autoComplete="off" />
            <small>Sin el RUC: solo el usuario secundario.</small></label>
          <label className="set-field"><span>Clave SOL *</span>
            <input required type="password" value={solPass} onChange={(e) => setSolPass(e.target.value)} autoComplete="new-password" placeholder={status.solUserMask ? "••••••••" : ""} />
            <small>{status.solUserMask ? "Guardar reemplaza la clave anterior." : "Se guarda cifrada."}</small></label>
          <div className="set-actions"><button className="app-btn primary" disabled={pending}>{pending ? "Guardando…" : status.solUserMask ? "Reemplazar credenciales" : "Guardar credenciales"}</button></div>
        </form>
      </section>

      <section className="app-panel">
        <header className="app-panel-head"><h2>Certificado digital</h2><span className="app-sub">Formato .pfx / .p12 o .pem (certificado + llave privada)</span></header>
        {status.certificate && (
          <p className="app-muted set-pad sun-cert">
            Actual: <strong>{status.certificate.subject ?? "—"}</strong><br />
            Huella SHA-256: <code>{status.certificate.fingerprint?.slice(0, 32)}…</code> · cargado {fmtDate(status.certificate.uploadedAt)}
          </p>
        )}
        <form className="set-form" onSubmit={(e) => {
          e.preventDefault();
          if (!certFile) return setMsg({ tone: "bad", text: "Seleccione el archivo del certificado." });
          const form = new FormData();
          form.set("file", certFile);
          form.set("password", certPass);
          run(() => uploadCertificateAction(form),
            (c) => `Certificado guardado: ${c.subject} · vence ${fmtDate(new Date(c.notAfter).toISOString())}.${c.warnings.length ? ` Atención: ${c.warnings.join(" ")}` : ""}`,
            () => { setCertFile(null); setCertPass(""); if (fileRef.current) fileRef.current.value = ""; });
        }}>
          <label className="set-field"><span>Archivo *</span>
            <input ref={fileRef} type="file" accept=".pfx,.p12,.pem,application/x-pkcs12,application/x-pem-file" onChange={(e) => setCertFile(e.target.files?.[0] ?? null)} /></label>
          <label className="set-field"><span>Contraseña del certificado</span>
            <input type="password" value={certPass} onChange={(e) => setCertPass(e.target.value)} autoComplete="new-password" />
            <small>La que le dio su proveedor de certificados (vacía si el .pem no tiene contraseña).</small></label>
          <div className="set-actions"><button className="app-btn primary" disabled={pending || !certFile}>{pending ? "Validando…" : status.certificate ? "Reemplazar certificado" : "Subir certificado"}</button></div>
        </form>
        <p className="app-muted set-pad">Se valida antes de guardar: contraseña, vigencia y que pertenezca a su RUC.</p>
      </section>

      <section className="app-panel">
        <header className="app-panel-head"><h2>Entorno de envío</h2></header>
        <div className="set-form">
          <div className="set-field wide">
            <div className="sun-env" role="radiogroup" aria-label="Entorno SUNAT">
              {(["BETA", "PRODUCTION"] as const).map((env) => (
                <button key={env} type="button" role="radio" aria-checked={status.env === env} className={status.env === env ? "on" : ""}
                  disabled={pending || status.env === env || (env === "PRODUCTION" && !status.readyForProduction.ok)}
                  onClick={() => {
                    if (env === "PRODUCTION" && !confirm("Desde ahora los comprobantes tendrán validez tributaria ante SUNAT. ¿Pasar a producción?")) return;
                    run(() => setSunatEnvAction({ env }), () => (env === "PRODUCTION" ? "Facturación en PRODUCCIÓN activada." : "Entorno cambiado a beta (pruebas)."));
                  }}>
                  <strong>{env === "BETA" ? "Beta (pruebas)" : "Producción"}</strong>
                  <span>{env === "BETA" ? "Comprobantes de prueba, sin validez tributaria" : "Comprobantes reales con validez ante SUNAT"}</span>
                </button>
              ))}
            </div>
            {!status.readyForProduction.ok && <small>Para activar producción falta: {status.readyForProduction.missing.join(", ")}.</small>}
          </div>
          <div className="set-actions">
            <button type="button" className="app-btn" disabled={pending || !status.certificate}
              title={status.certificate ? undefined : "Primero suba el certificado"}
              onClick={() => run(() => testBetaAction(), (o) => {
                const info = OUTCOME[o.kind] ?? { text: o.kind };
                return `${info.text}${o.kind.startsWith("ACCEPTED") ? "" : ` (${o.code}: ${o.description})`}`;
              })}>
              {pending ? "Probando con SUNAT…" : "Probar envío en beta"}
            </button>
          </div>
        </div>
      </section>

      {status.recent.length > 0 && (
        <section className="app-panel">
          <header className="app-panel-head"><h2>Últimos envíos a SUNAT</h2></header>
          <div className="app-table-wrap"><table className="app-table stack">
            <thead><tr><th>Fecha</th><th>Comprobante</th><th>Operación</th><th>Respuesta</th></tr></thead>
            <tbody>{status.recent.map((r, i) => (
              <tr key={`${r.at}-${i}`}>
                <td data-label="Fecha">{new Date(r.at).toLocaleString("es-PE", { timeZone: "America/Lima", dateStyle: "short", timeStyle: "short" })}</td>
                <td data-label="Comprobante"><strong>{r.document}</strong></td>
                <td data-label="Operación">{r.operation}</td>
                <td data-label="Respuesta">{r.code ? <span className={`app-pill ${r.code === "0" ? "green" : "red"}`}>{r.code}</span> : <span className="app-pill green">CDR</span>}
                  {r.text && <span className="app-sub">{r.text.slice(0, 140)}</span>}</td>
              </tr>
            ))}</tbody>
          </table></div>
        </section>
      )}
    </div>
  );
}
