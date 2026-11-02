import type { PleSummary } from "@/lib/reports/ple";
import { PLE_BOOKS } from "@/lib/reports/ple-format";
import { Panel, StatCard, soles } from "../../_components/ui";

/** Pestaña "Libros Electrónicos (PLE)": selector de periodo (GET) y descargas .txt. */
export function PleTab({ period, summary }: { period: string; summary: PleSummary }) {
  const href = (book: string) => `/app/reports/ple?book=${book}&period=${period}`;
  const { sales, purchases } = summary;
  return (
    <>
      <Panel title="Periodo a exportar">
        <form method="get" className="set-form">
          <input type="hidden" name="tab" value="ple" />
          <label className="set-field"><span>Mes</span><input type="month" name="period" defaultValue={period} required /></label>
          <div className="set-field"><span>&nbsp;</span><button type="submit" className="app-btn" style={{ width: "fit-content" }}>Ver periodo</button></div>
        </form>
      </Panel>
      <div style={{ height: 16 }} />
      <div className="app-stats">
        <StatCard label={PLE_BOOKS.sales.label} value={soles(sales.total)} hint={`${sales.documents} comprobantes`} icon="receipt" tone="blue" />
        <StatCard label={PLE_BOOKS.purchases.label} value={soles(purchases.total)} hint={`${purchases.documents} compras recibidas`} icon="truck" tone="violet" />
      </div>
      {(sales.notSent > 0 || sales.rejected > 0 || purchases.excluded > 0 || purchases.missingRate > 0) && (
        <div className="ple-notes" role="status">
          <strong>Revise antes de presentar:</strong>
          <ul>
            {sales.notSent > 0 && <li>{sales.notSent} comprobante(s) aún sin confirmar por SUNAT están incluidos.</li>}
            {sales.rejected > 0 && <li>{sales.rejected} comprobante(s) rechazados por SUNAT no se incluyen.</li>}
            {purchases.excluded > 0 && <li>{purchases.excluded} compra(s) con documento distinto de factura o boleta no se incluyen.</li>}
            {purchases.missingRate > 0 && <li>{purchases.missingRate} compra(s) en moneda extranjera no tienen tipo de cambio: complételo para poder exportar el 8.1.</li>}
          </ul>
        </div>
      )}
      <Panel title="Descargar archivos .txt">
        <div className="ple-actions">
          <a className="app-btn primary" href={href("sales")} download>Registro de Ventas (14.1)</a>
          <a className="app-btn primary" href={href("purchases")} download>Registro de Compras (8.1)</a>
        </div>
        <p className="app-muted set-pad">
          Estructura PLE 5.2 de SUNAT, en soles. Valide cada archivo con el programa PLE antes de presentarlo. Si su negocio está
          obligado a SIRE, los registros de ventas y compras se llevan allí: consúltelo con su contador.
        </p>
      </Panel>
    </>
  );
}
