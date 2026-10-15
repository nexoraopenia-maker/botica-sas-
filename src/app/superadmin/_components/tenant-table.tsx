import { platformDb } from "@/lib/db";
import { MODULES, STATUS_LABEL } from "@/app/superadmin/_components/catalog";
import { StatusButton } from "@/app/superadmin/_components/status-button";

const moduleLabel = (key: string) => MODULES.find((m) => m.key === key)?.label ?? key;

/** Listado de clientes (server component; consulta con el cliente de plataforma). */
export async function TenantTable() {
  const tenants = await platformDb().tenant.findMany({
    where: { status: { not: "DELETED" } },
    include: {
      modules: { where: { enabled: true } },
      subscriptions: { include: { plan: true }, orderBy: { created_at: "desc" }, take: 1 },
    },
    orderBy: { created_at: "desc" },
    take: 200,
  });

  if (tenants.length === 0) {
    return (
      <div className="card">
        <p className="muted" style={{ margin: 0 }}>Aún no hay clientes registrados. Use «Nuevo cliente» para crear el primero.</p>
      </div>
    );
  }

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr><th>Cliente</th><th>RUC</th><th>Estado</th><th>SUNAT</th><th>Plan</th><th>Módulos</th><th>Alta</th><th aria-label="Acciones" /></tr>
        </thead>
        <tbody>
          {tenants.map((t) => {
            const st = STATUS_LABEL[t.status] ?? { label: t.status, tone: "" };
            const name = t.trade_name ?? t.legal_name;
            return (
              <tr key={t.id}>
                <td>
                  <a href={`/superadmin/tenants/${t.id}`}>{name}</a>
                  {t.trade_name && <div className="muted" style={{ fontSize: 12 }}>{t.legal_name}</div>}
                </td>
                <td>{t.ruc}</td>
                <td><span className={`tag ${st.tone}`}>{st.label}</span></td>
                <td>{t.sunat_env === "BETA" ? "Beta" : "Producción"}</td>
                <td>{t.subscriptions[0]?.plan.name ?? "—"}</td>
                <td style={{ maxWidth: 260 }}>{t.modules.map((m) => moduleLabel(m.module)).join(", ")}</td>
                <td>{t.created_at.toLocaleDateString("es-PE", { timeZone: "America/Lima" })}</td>
                <td>
                  <div className="row-actions">
                    <a className="btn small" href={`/superadmin/tenants/${t.id}`}>Editar</a>
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
