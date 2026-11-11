"use client";

import Link from "next/link";
import { useRef, useState, useTransition } from "react";
import { Panel } from "../../_components/ui";
import { importProductsAction, type ImportResult } from "./actions";

const SHOWN_ERRORS = 50;
const ACTION: Record<string, string> = { create: "Nuevo", update: "Actualiza", same: "Sin cambios" };

export function ImportForm({ pharmacy }: { pharmacy: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function run(mode: "preview" | "apply") {
    if (!file) return setError("Seleccione un archivo .csv o .xlsx.");
    setError(null);
    start(async () => {
      const body = new FormData();
      body.set("file", file);
      body.set("mode", mode);
      const res = await importProductsAction(body);
      if (!res.ok) { setError(res.error.message); if (mode === "preview") setResult(null); return; }
      setResult(res.data);
    });
  }
  function pick(f: File | null) {
    setFile(f);
    setResult(null);
    setError(null);
  }

  const hasErrors = (result?.errors.length ?? 0) > 0;
  const nothing = !!result && !hasErrors && result.creates + result.updates === 0;

  return (
    <Panel title="Subir archivo">
      <div className="set-form">
        <label className="set-field wide"><span>Archivo (.csv o .xlsx, máx. 2 MB)</span>
          <input ref={input} type="file" accept=".csv,.xlsx,.txt" onChange={(e) => pick(e.target.files?.[0] ?? null)} />
        </label>
        <div className="wide rx-actions" style={{ justifyContent: "flex-start" }}>
          <button type="button" className="app-btn primary" disabled={!file || pending || result?.applied} onClick={() => run("preview")}>{pending && !result ? "Revisando…" : "Revisar archivo"}</button>
        </div>
        {error && <p className="set-msg bad wide" role="alert">{error}</p>}
      </div>

      {result && (
        <div className="set-pad" aria-live="polite">
          {result.applied && (
            <p className="set-msg ok" role="status" style={{ marginBottom: 16 }}>
              Listo: {result.creates} producto{result.creates === 1 ? "" : "s"} creado{result.creates === 1 ? "" : "s"} y {result.updates} actualizado{result.updates === 1 ? "" : "s"}.{" "}
              <Link href="/app/inventory">Ver productos</Link>
            </p>
          )}
          <div className="imp-stats">
            <div><strong>{result.creates}</strong><span>se crean</span></div>
            <div><strong>{result.updates}</strong><span>se actualizan</span></div>
            <div><strong>{result.unchanged}</strong><span>sin cambios</span></div>
            <div><strong>{result.newCategories.length}</strong><span>categorías nuevas</span></div>
          </div>

          {result.newCategories.length > 0 && (
            <p className="app-muted">Categorías que se crearán: {result.newCategories.map((c) => <span key={c} className="app-pill gray" style={{ marginRight: 4 }}>{c}</span>)}</p>
          )}
          {result.notes.map((n) => <p key={n} className="set-msg warn" style={{ marginBottom: 8 }}>{n}</p>)}
          {result.ignoredColumns.length > 0 && <p className="app-muted">Columnas no reconocidas, se ignoran: {result.ignoredColumns.join(", ")}.</p>}
          {!pharmacy && <p className="app-muted">Su negocio no tiene el módulo Farmacia: Principio Activo, Acción Terapéutica y Marca/Genérico no se cargan.</p>}

          {hasErrors && (
            <>
              <p className="set-msg bad" role="alert" style={{ margin: "12px 0" }}>
                Hay {result.errors.length} error{result.errors.length === 1 ? "" : "es"}: corríjalos en el archivo y vuelva a revisarlo. No se aplicó nada.
              </p>
              <div className="app-table-wrap"><table className="app-table">
                <thead><tr><th>Fila</th><th>Problema</th></tr></thead>
                <tbody>{result.errors.slice(0, SHOWN_ERRORS).map((e, i) => <tr key={`${e.line}-${i}`}><td>{e.line}</td><td>{e.message}</td></tr>)}</tbody>
              </table></div>
              {result.errors.length > SHOWN_ERRORS && <p className="app-muted">…y {result.errors.length - SHOWN_ERRORS} más.</p>}
            </>
          )}

          {!hasErrors && result.changes.length > 0 && (
            <div className="app-table-wrap" style={{ marginTop: 12 }}><table className="app-table">
              <thead><tr><th>Fila</th><th>SKU</th><th>Efecto</th><th>Campos</th></tr></thead>
              <tbody>{result.changes.map((c) => (
                <tr key={c.line}><td>{c.line}</td><td>{c.sku}</td>
                  <td><span className={`app-pill ${c.action === "create" ? "green" : c.action === "update" ? "amber" : "gray"}`}>{ACTION[c.action]}</span></td>
                  <td>{c.fields.join(", ") || "—"}</td></tr>
              ))}</tbody>
            </table></div>
          )}
          {!hasErrors && result.creates + result.updates + result.unchanged > result.changes.length && <p className="app-muted">Se muestran las primeras {result.changes.length} filas.</p>}

          {!hasErrors && !result.applied && (
            <div className="rx-actions" style={{ justifyContent: "flex-start", marginTop: 16 }}>
              <button type="button" className="app-btn primary" disabled={pending || nothing} onClick={() => run("apply")}>
                {pending ? "Aplicando…" : nothing ? "No hay cambios que aplicar" : `Aplicar ${result.creates + result.updates} cambio${result.creates + result.updates === 1 ? "" : "s"}`}
              </button>
              <button type="button" className="app-btn" disabled={pending} onClick={() => { pick(null); if (input.current) input.current.value = ""; }}>Cancelar</button>
            </div>
          )}
        </div>
      )}
    </Panel>
  );
}
