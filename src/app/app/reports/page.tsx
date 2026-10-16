import Link from "next/link";
import { requireTenant } from "@/lib/auth/session";
import { loadReports } from "@/lib/reports/queries";
import { formatStock } from "@/lib/pharmacy/fractioning";
import { D } from "@/lib/money";
import { EmptyState, PageHeader, Panel, StatCard } from "../_components/ui";
import { BarList, DailySalesChart } from "./_components/charts";

export const metadata = { title: "Reportes" };

const PERIODS = [7, 30, 90] as const;
const METHOD: Record<string, string> = { EFECTIVO: "Efectivo", YAPE: "Yape", PLIN: "Plin", TARJETA: "Tarjeta", TRANSFERENCIA: "Transferencia", CREDITO: "Crédito" };
const money = (v: number) => `S/ ${v.toLocaleString("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pct = (v: number | null) => (v === null ? "—" : `${(v * 100).toLocaleString("es-PE", { maximumFractionDigits: 1 })}%`);
const day = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

export default async function ReportsPage({ searchParams }: { searchParams: Promise<{ days?: string }> }) {
  const ctx = await requireTenant({ permission: "reports.read" });
  const { days: raw } = await searchParams;
  const days = PERIODS.find((p) => String(p) === raw) ?? 30;
  const r = await loadReports({ tenantId: ctx.tenantId, userId: ctx.userId }, days);
  const k = r.kpis;

  return (
    <>
      <PageHeader
        title="Reportes"
        subtitle={`Ventas, márgenes e inventario · del ${day(r.from)} al ${day(r.to)}`}
        actions={
          <div className="set-tabs" role="tablist" aria-label="Periodo" style={{ marginBottom: 0 }}>
            {PERIODS.map((p) => (
              <Link key={p} href={`/app/reports?days=${p}`} role="tab" aria-selected={p === days} className={p === days ? "on" : ""} scroll={false}>
                {p} días
              </Link>
            ))}
          </div>
        }
      />

      <div className="app-stats">
        <StatCard label="Ventas (con IGV)" value={money(k.salesGross)} hint={`${k.docs} comprobantes · ticket prom. ${k.avgTicket ? money(k.avgTicket) : "—"}`} icon="trend" tone="green" />
        <StatCard label="Margen bruto" value={money(k.margin)} hint={`${pct(k.marginPct)} sobre venta sin IGV`} icon="chart" tone="blue" />
        <StatCard label="Costo de lo vendido" value={money(k.cost)} hint={`Venta sin IGV ${money(k.salesNet)}`} icon="box" tone="violet" />
        <StatCard label="Notas de crédito" value={money(k.creditNotes)} hint="No descontadas de las ventas" icon="receipt" tone={k.creditNotes ? "amber" : "blue"} />
      </div>

      <div className="app-grid-2">
        <Panel title="Ventas por día (con IGV)">
          {k.docs === 0 ? (
            <EmptyState icon="chart" title="Sin ventas en el periodo" text="Las ventas registradas en el punto de venta aparecerán aquí." />
          ) : (
            <div className="viz-wrap">
              <DailySalesChart data={r.daily} />
              <details className="viz-table">
                <summary>Ver como tabla</summary>
                <table className="app-table">
                  <thead><tr><th>Fecha</th><th className="num">Ventas</th><th className="num">Comprobantes</th></tr></thead>
                  <tbody>{r.daily.filter((d) => d.docs > 0).map((d) => (
                    <tr key={d.date}><td>{day(d.date)}</td><td className="num">{money(d.total)}</td><td className="num">{d.docs}</td></tr>
                  ))}</tbody>
                </table>
              </details>
            </div>
          )}
        </Panel>
        <Panel title="Ventas por medio de pago">
          {r.byMethod.length === 0 ? <p className="app-muted set-pad">Sin pagos en el periodo.</p> : (
            <div className="viz-wrap">
              <BarList data={r.byMethod.map((m) => ({ label: METHOD[m.method] ?? m.method, value: m.total, sub: `${m.count} venta${m.count === 1 ? "" : "s"}` }))} />
            </div>
          )}
        </Panel>
      </div>

      <div style={{ height: 16 }} />
      <Panel title="Productos más vendidos y su margen">
        {r.topProducts.length === 0 ? <p className="app-muted set-pad">Sin ventas en el periodo.</p> : (
          <div className="app-table-wrap"><table className="app-table stack">
            <thead><tr><th>Producto</th><th className="num">Cantidad</th><th className="num">Venta sin IGV</th><th className="num">Costo</th><th className="num">Margen</th><th className="num">Margen %</th></tr></thead>
            <tbody>{r.topProducts.map((p) => (
              <tr key={`${p.sku}-${p.name}`}>
                <td data-label="Producto"><strong>{p.name}</strong>{p.sku && <span className="app-sub">{p.sku}</span>}</td>
                <td data-label="Cantidad" className="num">{p.qty.toLocaleString("es-PE")}</td>
                <td data-label="Venta sin IGV" className="num">{money(p.net)}</td>
                <td data-label="Costo" className="num">{money(p.cost)}</td>
                <td data-label="Margen" className="num"><strong>{money(p.margin)}</strong></td>
                <td data-label="Margen %" className="num">
                  <span className={`app-pill ${p.marginPct === null ? "gray" : p.marginPct < 0.1 ? "red" : p.marginPct < 0.25 ? "amber" : "green"}`}>{pct(p.marginPct)}</span>
                </td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Panel>

      <div style={{ height: 16 }} />
      <div className="app-stats">
        <StatCard label="Inventario valorizado (costo)" value={money(r.inventory.valueTotal)} hint="Stock actual × costo del lote" icon="box" tone="blue" href="/app/inventory" />
        <StatCard label="Por vencer (≤ 60 días)" value={money(r.inventory.valueExpiring60)} hint="Candidato a promoción" icon="clock" tone="amber" href="/app/inventory/expiry" />
        <StatCard label="Vencido (merma)" value={money(r.inventory.valueExpired)} hint="Bloqueado para la venta" icon="alert" tone={r.inventory.valueExpired ? "red" : "green"} href="/app/inventory/expiry" />
        <StatCard label="Productos con stock bajo" value={String(r.inventory.lowStock)} hint="En o bajo su mínimo" icon="box" tone={r.inventory.lowStock ? "amber" : "green"} href="/app/inventory" />
      </div>
      <Panel title="Mayor valor en inventario">
        {r.inventory.top.length === 0 ? <p className="app-muted set-pad">Sin stock registrado.</p> : (
          <div className="app-table-wrap"><table className="app-table stack">
            <thead><tr><th>Producto</th><th className="num">Stock</th><th className="num">Valor a costo</th><th>Próx. vencimiento</th></tr></thead>
            <tbody>{r.inventory.top.map((p) => (
              <tr key={p.sku}>
                <td data-label="Producto"><strong>{p.name}</strong><span className="app-sub">{p.sku}</span></td>
                <td data-label="Stock" className="num">{formatStock(D(p.stock), 1)}</td>
                <td data-label="Valor a costo" className="num">{money(p.value)}</td>
                <td data-label="Próx. vencimiento">{p.nearestExpiry ? day(p.nearestExpiry) : "—"}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Panel>
    </>
  );
}
