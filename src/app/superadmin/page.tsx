import { requirePlatformAdmin } from "@/lib/auth/session";
import { getPlatformDashboard } from "@/lib/platform/dashboard";
import { TenantTable } from "@/app/superadmin/_components/tenant-table";

export default async function SuperadminDashboard() {
  await requirePlatformAdmin();
  const d = await getPlatformDashboard();
  const active = d.tenantsByStatus.find((s) => s.status === "ACTIVE")?.count ?? 0;
  const trial = d.tenantsByStatus.find((s) => s.status === "TRIAL")?.count ?? 0;

  return (
    <main>
      <div className="page-head">
        <h1>Panel de plataforma</h1>
        <a className="btn primary" href="/superadmin/tenants/new">+ Nuevo cliente</a>
      </div>
      <div className="kpis">
        <div className="kpi">Clientes activos<b>{active}</b><small>{trial} en prueba</small></div>
        <div className="kpi">MRR<b>S/ {Number(d.mrrPen).toLocaleString("es-PE", { minimumFractionDigits: 2 })}</b></div>
        <div className="kpi">Comprobantes del mes<b>{d.documentsThisMonth.toLocaleString("es-PE")}</b></div>
        <div className="kpi">Eventos en cola muerta<b>{d.deadOutbox}</b></div>
      </div>

      <h2>Clientes</h2>
      <TenantTable />

      <h2>Errores SUNAT (30 días)</h2>
      <table>
        <thead><tr><th>Cliente</th><th>Rechazados</th><th>Reintentando</th></tr></thead>
        <tbody>{d.sunatErrors30d.map((r) => <tr key={r.tenant_id}><td>{r.legal_name}</td><td>{r.rejected}</td><td>{r.retrying}</td></tr>)}</tbody>
      </table>

      <h2>Certificados por vencer</h2>
      <table>
        <thead><tr><th>Cliente</th><th>Vence</th><th>Días</th></tr></thead>
        <tbody>
          {d.certificatesExpiring.map((c) => (
            <tr key={c.tenant_id}>
              <td>{c.legal_name}</td><td>{c.expires_at.toISOString().slice(0, 10)}</td>
              <td><span className={`tag ${c.days_left <= 7 ? "bad" : "warn"}`}>{c.days_left}</span></td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Consumo de IA (mes)</h2>
      <table>
        <thead><tr><th>Cliente</th><th>Documentos</th><th>Tokens entrada</th><th>Tokens salida</th></tr></thead>
        <tbody>{d.aiUsage.map((a) => <tr key={a.tenant_id}><td>{a.legal_name}</td><td>{a.pages}</td><td>{a.input_tokens.toLocaleString("es-PE")}</td><td>{a.output_tokens.toLocaleString("es-PE")}</td></tr>)}</tbody>
      </table>
    </main>
  );
}
