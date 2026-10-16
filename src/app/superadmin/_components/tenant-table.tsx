import Link from "next/link";
import { platformDb } from "@/lib/db";
import type { PlatformAdminContext } from "@/lib/auth/session";
import { MODULES, STATUS_LABEL } from "@/app/superadmin/_components/catalog";
import { StatusButton } from "@/app/superadmin/_components/status-button";
import { EnterPanelButton } from "@/app/superadmin/_components/enter-panel-button";
import { EmptyState } from "@/app/app/_components/ui";

const moduleLabel = (key: string) => MODULES.find((m) => m.key === key)?.label ?? key;

/** Listado de clientes (server component; consulta con el cliente de plataforma). */
export async function TenantTable({ admin, limit = 200 }: { admin: PlatformAdminContext; limit?: number }) {
  const tenants = await platformDb().tenant.findMany({
    where: { status: { not: "DELETED" } },
    include: {
      modules: { where: { enabled: true } },
      subscriptions: { include: { plan: true }, orderBy: { created_at: "desc" }, take: 1 },
      _count: { select: { members: { where: { deleted_at: null, status: "ACTIVE" } } } },
    },
    orderBy: { created_at: "desc" },
    take: limit,
  });

  if (tenants.length === 0) {
    return (
      <EmptyState icon="building" title="Aún no hay clientes" text="Registre su primer cliente para empezar."
        action={<Link href="/superadmin/tenants/new" className="app-btn primary">+ Nuevo cliente</Link>} />
    );
  }

  return (
    <div className="app-table-wrap">
      <table className="app-table stack">
        <thead>
          <tr><th>Cliente</th><th>Estado</th><th>SUNAT</th><th>Plan</th><th>Módulos</th><th className="num">Usuarios</th><th>Alta</th><th aria-label="Acciones" /></tr>
        </thead>
        <tbody>
          {tenants.map((t) => {
            const st = STATUS_LABEL[t.status] ?? { label: t.status, tone: "gray" };
            const name = t.trade_name ?? t.legal_name;
            const sub = t.subscriptions[0];
            return (
              <tr key={t.id}>
                <td data-label="Cliente">
                  <Link href={`/superadmin/tenants/${t.id}`} className="sa-name">{name}</Link>
                  <span className="app-sub">RUC {t.ruc}{t.trade_name ? ` · ${t.legal_name}` : ""}</span>
                </td>
                <td data-label="Estado"><span className={`app-pill ${st.tone}`}>{st.label}</span></td>
                <td data-label="SUNAT">
                  <span className={`app-pill ${t.sunat_env === "PRODUCTION" ? "green" : "amber"}`}>{t.sunat_env === "PRODUCTION" ? "Producción" : "Beta"}</span>
                </td>
                <td data-label="Plan">{sub ? <>{sub.plan.name}{sub.status === "TRIALING" && <span className="app-sub">en prueba</span>}</> : "—"}</td>
                <td data-label="Módulos">
                  <div className="sa-modules">{t.modules.filter((m) => m.module !== "CORE").map((m) => <span key={m.module} className="app-pill gray">{moduleLabel(m.module)}</span>)}</div>
                </td>
                <td data-label="Usuarios" className="num">{t._count.members}</td>
                <td data-label="Alta">{t.created_at.toLocaleDateString("es-PE", { timeZone: "America/Lima" })}</td>
                <td data-label="">
                  <div className="row-actions sa-actions">
                    <EnterPanelButton tenantId={t.id} name={name} canWrite={admin.role === "OWNER"} />
                    <Link className="app-btn small" href={`/superadmin/tenants/${t.id}`}>Editar</Link>
                    <StatusButton tenantId={t.id} name={name} status={t.status} />
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
