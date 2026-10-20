import Link from "next/link";
import { requirePlatformAdmin } from "@/lib/auth/session";
import { getPlatformDashboard } from "@/lib/platform/dashboard";
import { TenantTable } from "@/app/superadmin/_components/tenant-table";
import { PageHeader, Panel, StatCard } from "@/app/app/_components/ui";

const money = (v: number) => `S/ ${v.toLocaleString("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const num = (v: number) => v.toLocaleString("es-PE");

const SUPPORT_MSG: Record<string, string> = {
  expirado: "La sesión de soporte terminó o expiró. Use «Entrar al panel» en el cliente para abrir una nueva.",
  requerido: "Para ver el panel de un cliente use «Entrar al panel» en la tabla de clientes.",
};

export default async function SuperadminDashboard({ searchParams }: { searchParams: Promise<{ soporte?: string }> }) {
  const admin = await requirePlatformAdmin();
  const { soporte } = await searchParams;
  const d = await getPlatformDashboard();
  const count = (s: string) => d.tenantsByStatus.find((x) => x.status === s)?.count ?? 0;
  const active = count("ACTIVE");
  const trial = count("TRIAL");
  const suspended = count("SUSPENDED");
  const certsSoon = d.certificatesExpiring.filter((c) => c.days_left <= 30).length;

  return (
    <>
      <PageHeader title="Panel de plataforma" subtitle="Clientes, ingresos y salud operativa de Nexo ERP"
        actions={<Link className="app-btn primary" href="/superadmin/tenants/new">+ Nuevo cliente</Link>} />

      {soporte && SUPPORT_MSG[soporte] && <p className="set-msg bad" role="status" style={{ marginBottom: 16 }}>{SUPPORT_MSG[soporte]}</p>}

      <div className="app-stats">
        <StatCard label="Clientes activos" value={num(active)} hint={`${trial} en prueba${suspended ? ` · ${suspended} suspendidos` : ""}`} icon="building" tone="blue" href="/superadmin/tenants" />
        <StatCard label="MRR (ingreso mensual recurrente)" value={money(Number(d.mrrPen))} hint="Suscripciones activas" icon="trend" tone="green" />
        <StatCard label="Comprobantes del mes" value={num(d.documentsThisMonth)} hint="Emitidos por todos los clientes" icon="receipt" tone="violet" />
        <StatCard label="Eventos en cola muerta" value={num(d.deadOutbox)} hint={d.deadOutbox ? "Requieren revisión manual" : "Sin envíos atascados"} icon="alert" tone={d.deadOutbox ? "red" : "green"} />
      </div>

      <Panel title="Clientes" action={<Link href="/superadmin/tenants" className="app-link">Ver todos</Link>}>
        <TenantTable admin={admin} limit={10} />
      </Panel>

      <div style={{ height: 16 }} />
      <div className="sa-grid-3">
        <Panel title="Errores SUNAT (30 días)">
          {d.sunatErrors30d.length === 0 ? <p className="app-muted set-pad">Sin rechazos ni reintentos en los últimos 30 días.</p> : (
            <div className="app-table-wrap"><table className="app-table stack">
              <thead><tr><th>Cliente</th><th className="num">Rechazados</th><th className="num">Reintentando</th></tr></thead>
              <tbody>{d.sunatErrors30d.map((r) => (
                <tr key={r.tenant_id}>
                  <td data-label="Cliente"><Link href={`/superadmin/tenants/${r.tenant_id}`} className="sa-name">{r.legal_name}</Link></td>
                  <td data-label="Rechazados" className="num"><span className={`app-pill ${r.rejected ? "red" : "gray"}`}>{r.rejected}</span></td>
                  <td data-label="Reintentando" className="num"><span className={`app-pill ${r.retrying ? "amber" : "gray"}`}>{r.retrying}</span></td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
        </Panel>

        <Panel title={`Certificados por vencer${certsSoon ? ` (${certsSoon})` : ""}`}>
          {d.certificatesExpiring.length === 0 ? <p className="app-muted set-pad">Ningún certificado digital vence en los próximos 45 días.</p> : (
            <div className="app-table-wrap"><table className="app-table stack">
              <thead><tr><th>Cliente</th><th>Vence</th><th className="num">Días</th></tr></thead>
              <tbody>{d.certificatesExpiring.map((c) => (
                <tr key={c.tenant_id}>
                  <td data-label="Cliente"><Link href={`/superadmin/tenants/${c.tenant_id}`} className="sa-name">{c.legal_name}</Link></td>
                  <td data-label="Vence">{c.expires_at.toLocaleDateString("es-PE", { timeZone: "America/Lima" })}</td>
                  <td data-label="Días" className="num">
                    <span className={`app-pill ${c.days_left < 0 ? "red" : c.days_left <= 7 ? "red" : c.days_left <= 30 ? "amber" : "blue"}`}>
                      {c.days_left < 0 ? `Vencido hace ${-c.days_left}` : c.days_left}
                    </span>
                  </td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
        </Panel>

        <Panel title="Consumo de IA (mes)">
          {d.aiUsage.length === 0 ? <p className="app-muted set-pad">Ningún cliente usó la carga de facturas con IA este mes.</p> : (
            <div className="app-table-wrap"><table className="app-table stack">
              <thead><tr><th>Cliente</th><th className="num">Documentos</th><th className="num">Tokens</th></tr></thead>
              <tbody>{d.aiUsage.map((a) => (
                <tr key={a.tenant_id}>
                  <td data-label="Cliente"><Link href={`/superadmin/tenants/${a.tenant_id}`} className="sa-name">{a.legal_name}</Link></td>
                  <td data-label="Documentos" className="num"><span className="app-pill blue">{num(a.pages)}</span></td>
                  <td data-label="Tokens" className="num">{num(a.input_tokens + a.output_tokens)}<span className="app-sub">{num(a.input_tokens)} entrada · {num(a.output_tokens)} salida</span></td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
        </Panel>
      </div>
    </>
  );
}
