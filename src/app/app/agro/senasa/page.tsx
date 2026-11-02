import Link from "next/link";
import { requirePage } from "@/lib/auth/session";
import { hasPermission } from "@/lib/auth/permissions";
import { withTenant } from "@/lib/db";
import { EmptyState, PageHeader, Panel, StatCard } from "../../_components/ui";

export const metadata = { title: "Control SENASA" };

/** Productos de uso animal (con especie destino o retiro) y su registro SENASA. */
export default async function SenasaPage() {
  const ctx = await requirePage({ permission: "inventory.read", module: "AGRO" });
  const rows = await withTenant({ tenantId: ctx.tenantId, userId: ctx.userId }, (tx) => tx.product.findMany({
    where: {
      deleted_at: null, is_active: true,
      OR: [{ senasa_registration: { not: null } }, { withdrawal_days_meat: { gt: 0 } }, { withdrawal_days_milk: { gt: 0 } }, { target_species: { isEmpty: false } }],
    },
    orderBy: { name: "asc" },
    select: { id: true, sku: true, name: true, senasa_registration: true, withdrawal_days_meat: true, withdrawal_days_milk: true },
  }));
  const missing = rows.filter((r) => !r.senasa_registration).length;
  return (
    <>
      <PageHeader title="Control SENASA" subtitle="Registros sanitarios de sus productos veterinarios"
        actions={hasPermission(ctx.permissions, "products.manage") ? <Link href="/app/inventory/new" className="app-btn primary">+ Nuevo producto</Link> : undefined} />
      <div className="app-stats">
        <StatCard label="Productos de uso animal" value={String(rows.length)} icon="leaf" tone="blue" />
        <StatCard label="Sin registro SENASA" value={String(missing)} hint={missing ? "Complete el registro de estos productos" : "Todos tienen registro"} icon="alert" tone={missing ? "red" : "green"} />
      </div>
      <Panel>
        {rows.length === 0 ? <EmptyState icon="leaf" title="Sin productos de uso animal" text="Al registrar productos con registro SENASA o periodo de retiro aparecerán aquí." /> : (
          <div className="app-table-wrap"><table className="app-table stack">
            <thead><tr><th>Producto</th><th>Registro SENASA</th><th className="num">Retiro carne</th><th className="num">Retiro leche</th></tr></thead>
            <tbody>{rows.map((p) => (
              <tr key={p.id}>
                <td data-label="Producto"><strong>{p.name}</strong><span className="app-sub">{p.sku}</span></td>
                <td data-label="Registro SENASA">{p.senasa_registration ?? <span className="app-pill red">Falta registro</span>}</td>
                <td data-label="Retiro carne" className="num">{p.withdrawal_days_meat ?? "—"}</td>
                <td data-label="Retiro leche" className="num">{p.withdrawal_days_milk ?? "—"}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Panel>
    </>
  );
}
