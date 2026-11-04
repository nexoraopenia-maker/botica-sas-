import Link from "next/link";
import { requirePage } from "@/lib/auth/session";
import { hasPermission } from "@/lib/auth/permissions";
import { withTenant } from "@/lib/db";
import { loadCommissions } from "@/lib/reports/commissions";
import { limaNow } from "@/lib/time";
import { EmptyState, PageHeader, Panel, StatCard, soles } from "../../_components/ui";
import { RateInput } from "./rate-input";

export const metadata = { title: "Comisiones" };

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f-]{36}$/i;

export default async function CommissionsPage({ searchParams }: { searchParams: Promise<{ desde?: string; hasta?: string; vendedor?: string }> }) {
  const params = await searchParams;
  const ctx = await requirePage({ permission: "reports.read" });
  const db = { tenantId: ctx.tenantId, userId: ctx.userId };
  const today = limaNow().date;
  const to = params.hasta && DATE.test(params.hasta) ? params.hasta : today;
  const from = params.desde && DATE.test(params.desde) ? params.desde : `${today.slice(0, 7)}-01`;
  const seller = params.vendedor && UUID.test(params.vendedor) ? params.vendedor : undefined;
  const canEditRates = hasPermission(ctx.permissions, "users.manage");
  const [report, members, rates] = await Promise.all([
    loadCommissions(db, from, to, seller),
    withTenant(db, (tx) => tx.tenantUser.findMany({ where: { deleted_at: null }, include: { user: { select: { full_name: true, email: true } }, role: { select: { permissions: true } } } })),
    withTenant(db, (tx) => tx.sellerCommissionRate.findMany()),
  ]);
  const sellers = members.filter((m) => m.role.permissions.includes("*") || m.role.permissions.includes("pos.sell"))
    .map((m) => ({ id: m.user_id, name: m.user.full_name ?? m.user.email })).sort((a, b) => a.name.localeCompare(b.name));
  return (
    <>
      <PageHeader title="Comisiones" subtitle="Por vendedor, sobre la venta sin IGV y con el porcentaje vigente al vender"
        actions={<Link href="/app/reports" className="app-btn">Volver a Reportes</Link>} />
      <Panel title="Filtros">
        <form method="get" className="set-form">
          <label className="set-field"><span>Desde</span><input type="date" name="desde" defaultValue={from} required /></label>
          <label className="set-field"><span>Hasta</span><input type="date" name="hasta" defaultValue={to} required /></label>
          <label className="set-field"><span>Vendedor</span>
            <select name="vendedor" defaultValue={seller ?? ""}>
              <option value="">Todos</option>
              {sellers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select></label>
          <div className="set-field"><span>&nbsp;</span><button type="submit" className="app-btn" style={{ width: "fit-content" }}>Ver</button></div>
        </form>
      </Panel>
      <div style={{ height: 16 }} />
      <div className="app-stats">
        <StatCard label="Venta sin IGV" value={soles(report.totalBase)} hint="Descontadas las notas de crédito" icon="trend" tone="blue" />
        <StatCard label="Comisiones" value={soles(report.totalCommission)} hint={`${report.sellers.length} vendedor(es)`} icon="users" tone="green" />
      </div>
      <Panel>
        {report.sellers.length === 0 ? <EmptyState icon="users" title="Sin ventas en el periodo" text="Las ventas con vendedor asignado aparecerán aquí. Las anteriores a este módulo no tienen vendedor." /> : (
          report.sellers.map((s) => (
            <details key={s.sellerId} className="viz-table" open={!!seller}>
              <summary className="set-pad"><strong>{s.name}</strong> · {s.documents} comprobante(s) · venta {soles(s.base)} · comisión <strong>{soles(s.commission)}</strong></summary>
              <div className="app-table-wrap"><table className="app-table stack">
                <thead><tr><th>Comprobante</th><th>Fecha</th><th className="num">Venta sin IGV</th><th className="num">%</th><th className="num">Comisión</th></tr></thead>
                <tbody>{s.lines.map((l) => (
                  <tr key={l.id}>
                    <td data-label="Comprobante"><strong>{l.label}</strong>{l.isNote && <span className="app-sub">Nota de crédito</span>}</td>
                    <td data-label="Fecha">{l.date}</td>
                    <td data-label="Venta sin IGV" className="num">{soles(l.base)}</td>
                    <td data-label="%" className="num">{l.percent}</td>
                    <td data-label="Comisión" className="num">{soles(l.commission)}</td>
                  </tr>
                ))}</tbody>
              </table></div>
            </details>
          ))
        )}
      </Panel>
      {canEditRates && (
        <>
          <div style={{ height: 16 }} />
          <Panel title="Porcentaje por vendedor">
            <p className="app-muted set-pad" style={{ marginBottom: 0 }}>Un cambio solo afecta a las ventas nuevas. Sin porcentaje, la comisión es 0.</p>
            <div className="app-table-wrap"><table className="app-table"><tbody>{sellers.map((s) => (
              <tr key={s.id}><td>{s.name}</td><td className="num"><RateInput userId={s.id} name={s.name} percent={rates.find((r) => r.user_id === s.id)?.percent.toFixed(2) ?? "0.00"} /></td></tr>
            ))}</tbody></table></div>
          </Panel>
        </>
      )}
    </>
  );
}
