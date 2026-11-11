import Link from "next/link";
import { requirePage } from "@/lib/auth/session";
import { loadControlledReport, loadPriceReport } from "@/lib/reports/digemid";
import { limaNow } from "@/lib/time";
import { EmptyState, PageHeader, Panel, StatCard, soles } from "../../_components/ui";
import { CodeInput } from "./code-input";

export const metadata = { title: "Reportes DIGEMID" };

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export default async function DigemidPage({ searchParams }: { searchParams: Promise<{ tab?: string; desde?: string; hasta?: string }> }) {
  const params = await searchParams;
  const ctx = await requirePage({ permission: "pharmacy.controlled_log", module: "PHARMACY" });
  const db = { tenantId: ctx.tenantId, userId: ctx.userId };
  const controlled = params.tab === "controlados";
  const today = limaNow().date;
  const to = params.hasta && DATE.test(params.hasta) ? params.hasta : today;
  const from = params.desde && DATE.test(params.desde) ? params.desde : `${today.slice(0, 7)}-01`;

  return (
    <>
      <PageHeader title="Reportes DIGEMID" subtitle="Observatorio de Precios y control de psicotrópicos y estupefacientes" />
      <div className="set-tabs" role="tablist" aria-label="Reporte">
        <Link href="/app/reports/digemid" role="tab" aria-selected={!controlled} className={controlled ? "" : "on"}>Observatorio de Precios</Link>
        <Link href="/app/reports/digemid?tab=controlados" role="tab" aria-selected={controlled} className={controlled ? "on" : ""}>Psicotrópicos y estupefacientes</Link>
      </div>
      {controlled ? <Controlled db={db} from={from} to={to} /> : <Prices ctx={{ ...db, branchIds: ctx.branchIds }} />}
    </>
  );
}

async function Prices({ ctx }: { ctx: { tenantId: string; userId: string; branchIds: string[] } }) {
  const r = await loadPriceReport(ctx);
  const missing = r.products.filter((p) => !p.code).length;
  return (
    <>
      <div className="app-stats">
        <StatCard label="Productos con código" value={String(r.products.length - missing)} hint="Se incluyen en el archivo" icon="book" tone="green" />
        <StatCard label="Sin código DIGEMID" value={String(missing)} hint={missing ? "No se incluyen hasta completarlo" : "Todos completos"} icon="alert" tone={missing ? "amber" : "green"} />
      </div>
      <Panel title="Archivo de carga">
        <div className="app-table-wrap"><table className="app-table stack">
          <thead><tr><th>Sucursal</th><th>Código de establecimiento</th><th /></tr></thead>
          <tbody>{r.branches.map((b) => (
            <tr key={b.id}>
              <td data-label="Sucursal"><strong>{b.name}</strong></td>
              <td data-label="Código"><CodeInput kind="branch" id={b.id} value={b.code} label={`Código de establecimiento de ${b.name}`} /></td>
              <td data-label="">{b.code ? <a className="app-btn primary" href={`/app/reports/digemid/precios?branch=${b.id}`} download>Descargar Excel</a> : <span className="app-muted">Registre el código para descargar</span>}{" "}
                <a className="app-btn" href={`/app/reports/digemid/revision?branch=${b.id}`} download>Precios y stock (CSV)</a></td>
            </tr>
          ))}</tbody>
        </table></div>
        <p className="app-muted set-pad">
          Columnas CodEstab, CodProd, Precio 1 (empaque) y Precio 2 (unidad), en la hoja Hoja1, con precios con IGV. El archivo de carga no lleva stock. El CSV «Precios y stock» es
          una hoja de revisión con el código, el precio y el stock vendible de la sucursal. Compare el archivo con la plantilla vigente del Observatorio antes de la primera carga, porque DIGEMID puede cambiarla.
        </p>
      </Panel>
      <div style={{ height: 16 }} />
      <Panel title="Productos">
        {r.products.length === 0 ? <EmptyState icon="rx" title="Sin productos farmacéuticos" text="Los productos con DCI, registro sanitario o condición de venta aparecerán aquí." /> : (
          <div className="app-table-wrap"><table className="app-table stack">
            <thead><tr><th>Producto</th><th>Código catálogo DIGEMID</th><th className="num">Precio empaque</th><th className="num">Precio unidad</th></tr></thead>
            <tbody>{r.products.map((p) => (
              <tr key={p.id}>
                <td data-label="Producto"><strong>{p.name}</strong><span className="app-sub">{p.sku}{p.unitsPerPackage > 1 ? ` · empaque x${p.unitsPerPackage}` : ""}</span></td>
                <td data-label="Código"><CodeInput kind="product" id={p.id} value={p.code} label={`Código DIGEMID de ${p.name}`} /></td>
                <td data-label="Precio empaque" className="num">{soles(p.packagePrice)}</td>
                <td data-label="Precio unidad" className="num">{soles(p.unitPrice)}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Panel>
    </>
  );
}

async function Controlled({ db, from, to }: { db: { tenantId: string; userId: string }; from: string; to: string }) {
  const rows = await loadControlledReport(db, from, to);
  return (
    <>
      <Panel title="Periodo">
        <form method="get" className="set-form">
          <input type="hidden" name="tab" value="controlados" />
          <label className="set-field"><span>Desde</span><input type="date" name="desde" defaultValue={from} required /></label>
          <label className="set-field"><span>Hasta</span><input type="date" name="hasta" defaultValue={to} required /></label>
          <div className="set-field"><span>&nbsp;</span>
            <div className="rx-actions" style={{ justifyContent: "flex-start" }}>
              <button type="submit" className="app-btn">Ver</button>
              <a className="app-btn primary" href={`/app/reports/digemid/controlados?desde=${from}&hasta=${to}`} download>Exportar CSV</a>
            </div>
          </div>
        </form>
      </Panel>
      <div style={{ height: 16 }} />
      <Panel>
        {rows.length === 0 ? <EmptyState icon="book" title="Sin movimientos en el periodo" text="Las compras y ventas de productos controlados aparecen aquí con su lote y su receta." /> : (
          <div className="app-table-wrap"><table className="app-table stack">
            <thead><tr><th>Fecha</th><th>Producto</th><th>Lote</th><th>Movimiento</th><th className="num">Cantidad</th><th className="num">Saldo</th><th>Receta</th><th>Documento</th></tr></thead>
            <tbody>{rows.map((r, i) => (
              <tr key={`${r.occurredAt}-${i}`}>
                <td data-label="Fecha">{r.occurredAt}</td>
                <td data-label="Producto"><strong>{r.product}</strong>{(r.dci || r.list) && <span className="app-sub">{[r.dci, r.list].filter(Boolean).join(" · ")}</span>}</td>
                <td data-label="Lote">{r.lot ?? "—"}{r.expiry && <span className="app-sub">Vence {r.expiry}</span>}</td>
                <td data-label="Movimiento"><span className={`app-pill ${r.movement === "Ingreso" ? "green" : r.movement === "Salida" ? "amber" : "gray"}`}>{r.movement}</span></td>
                <td data-label="Cantidad" className="num">{r.quantity}</td>
                <td data-label="Saldo" className="num"><strong>{r.balance}</strong></td>
                <td data-label="Receta">{r.prescriber ? <>{r.prescriber}<span className="app-sub">Col. {r.prescriberCmp}{r.prescriberDoc ? ` · DNI ${r.prescriberDoc}` : ""} · {r.patient}</span></> : "—"}</td>
                <td data-label="Documento">{r.document ?? r.purchase ?? "—"}{r.counterparty && <span className="app-sub">{r.counterparty}</span>}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Panel>
    </>
  );
}
