import Link from "next/link";
import { requireTenant } from "@/lib/auth/session";
import { hasPermission } from "@/lib/auth/permissions";
import { loadExpiryOverview } from "@/lib/inventory/expiry";
import { EmptyState, PageHeader, Panel, StatCard, soles } from "../../_components/ui";
import { WasteButton } from "./waste-button";

export const metadata = { title: "Caducidad por lote" };

const LABEL: Record<string, [string, string]> = {
  EXPIRED: ["Vencido", "red"], D7: ["≤ 7 días", "red"], D15: ["≤ 15 días", "amber"], D30: ["≤ 30 días", "amber"],
  D60: ["≤ 60 días", "blue"], D90: ["≤ 90 días", "gray"],
};
const when = (d: Date) => d.toLocaleString("es-PE", { timeZone: "America/Lima", dateStyle: "short", timeStyle: "short" });

export default async function ExpiryPage({ searchParams }: { searchParams: Promise<{ ver?: string }> }) {
  const { ver } = await searchParams;
  const view = ver === "todos" ? "todos" : "criticos";
  const ctx = await requireTenant({ permission: "inventory.read" });
  const o = await loadExpiryOverview({ tenantId: ctx.tenantId, userId: ctx.userId }, ctx.branchIds, view);
  const canWaste = hasPermission(ctx.permissions, "inventory.waste");
  const canControlled = hasPermission(ctx.permissions, "pharmacy.controlled_log");
  const criticalLots = o.expired.lots + o.critical.lots;

  return (
    <>
      <PageHeader title="Caducidad por lote" subtitle="Lotes vencidos y próximos a vencer, y las mermas registradas. Los vencidos están bloqueados para la venta."
        actions={<Link href="/app/inventory" className="app-btn">← Productos</Link>} />
      <div className="app-stats">
        <StatCard label="Lotes vencidos" value={String(o.expired.lots)} hint={o.expired.lots ? `${soles(o.expired.value)} al costo` : "Ninguno con stock"} icon="alert" tone={o.expired.lots ? "red" : "green"} />
        <StatCard label="Vencen en ≤ 30 días" value={String(o.critical.lots)} hint={o.critical.lots ? `${soles(o.critical.value)} al costo` : "Ninguno"} icon="clock" tone={o.critical.lots ? "amber" : "green"} />
        <StatCard label="Mermas de 30 días" value={soles(o.wasteValue30d)} hint="Costo de lo dado de baja" icon="box" tone="violet" />
      </div>
      {o.expired.lots > 0 && (
        <p className="set-msg bad" role="alert" style={{ margin: "16px 0" }}>
          Hay {o.expired.lots} lote{o.expired.lots === 1 ? "" : "s"} vencido{o.expired.lots === 1 ? "" : "s"} con stock. No se pueden vender, pero siguen en su inventario:
          regístrelos como merma o devuélvalos al proveedor antes de una inspección de DIGEMID.
        </p>
      )}

      <div className="set-tabs" role="tablist" aria-label="Lotes">
        <Link href="/app/inventory/expiry" role="tab" aria-selected={view === "criticos"} className={view === "criticos" ? "on" : ""}>Críticos (vencidos y ≤ 30 días){criticalLots ? ` · ${criticalLots}` : ""}</Link>
        <Link href="/app/inventory/expiry?ver=todos" role="tab" aria-selected={view === "todos"} className={view === "todos" ? "on" : ""}>Todos (hasta 90 días)</Link>
      </div>
      <Panel>
        {o.rows.length === 0 ? (
          <EmptyState icon="clock" title={view === "criticos" ? "Ningún lote crítico" : "Ningún lote por vencer"}
            text={view === "criticos" ? "No hay lotes vencidos ni que venzan en los próximos 30 días." : "No hay lotes con stock que venzan en los próximos 90 días."} />
        ) : (
          <div className="app-table-wrap"><table className="app-table stack">
            <thead><tr><th>Producto</th><th>Lote</th><th>Vence</th><th>Estado</th><th className="num">Stock</th><th className="num">Valor</th><th>Acción sugerida</th>{canWaste && <th aria-label="Acciones" />}</tr></thead>
            <tbody>{o.rows.map((r) => {
              const [label, tone] = LABEL[r.bucket] ?? [r.bucket, "gray"];
              return (
                <tr key={r.batch_id}>
                  <td data-label="Producto"><strong>{r.product_name}</strong><span className="app-sub">{r.sku}{r.is_controlled ? " · Controlado" : ""}</span></td>
                  <td data-label="Lote">{r.lot_code}</td>
                  <td data-label="Vence">{r.expiry_date.toISOString().slice(0, 10)}</td>
                  <td data-label="Estado"><span className={`app-pill ${tone}`}>{label}</span></td>
                  <td data-label="Stock" className="num">{r.stock}</td>
                  <td data-label="Valor" className="num">{soles(r.stock_value)}</td>
                  <td data-label="Acción sugerida">{r.bucket === "EXPIRED" ? "Registrar merma o devolver al proveedor" : r.days_to_expiry <= 30 ? "Venda primero (FEFO), promocione o devuelva al proveedor" : r.days_to_expiry <= 60 ? "Promoción o exhibición preferente" : "Monitorear"}</td>
                  {canWaste && (
                    <td data-label="">
                      {r.is_controlled && !canControlled
                        ? <span className="app-muted">Solo el químico farmacéutico</span>
                        : <WasteButton batchId={r.batch_id} product={r.product_name} lot={r.lot_code} stock={r.stock} expired={r.bucket === "EXPIRED"} controlled={r.is_controlled} />}
                    </td>
                  )}
                </tr>
              );
            })}</tbody>
          </table></div>
        )}
      </Panel>

      <div style={{ height: 16 }} />
      <Panel title="Mermas de los últimos 30 días">
        {o.recentWaste.length === 0 ? (
          <EmptyState icon="box" title="Sin mermas registradas" text="Las salidas por vencimiento, daño o retiro del mercado quedan aquí, con quién las registró y su costo." />
        ) : (
          <div className="app-table-wrap"><table className="app-table stack">
            <thead><tr><th>Fecha</th><th>Producto</th><th>Lote</th><th className="num">Cantidad</th><th className="num">Costo</th><th>Motivo</th><th>Registró</th></tr></thead>
            <tbody>{o.recentWaste.map((w) => (
              <tr key={w.id}>
                <td data-label="Fecha">{when(w.created_at)}</td>
                <td data-label="Producto"><strong>{w.product}</strong></td>
                <td data-label="Lote">{w.lot ?? "—"}</td>
                <td data-label="Cantidad" className="num">{w.quantity}</td>
                <td data-label="Costo" className="num">{soles(w.value)}</td>
                <td data-label="Motivo">{w.note ?? "—"}</td>
                <td data-label="Registró">{w.user ?? "—"}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Panel>
    </>
  );
}
