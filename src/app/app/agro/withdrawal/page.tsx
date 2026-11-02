import { requireTenant } from "@/lib/auth/session";
import { withTenant } from "@/lib/db";
import { EmptyState, PageHeader, Panel } from "../../_components/ui";
import { WithdrawalCalculator } from "../_components/withdrawal-calculator";

export default async function WithdrawalPage() {
  const ctx = await requireTenant({ permission: "inventory.read", module: "AGRO" });
  const rows = await withTenant({ tenantId: ctx.tenantId, userId: ctx.userId }, (tx) =>
    tx.product.findMany({
      where: { deleted_at: null, OR: [{ withdrawal_days_meat: { gt: 0 } }, { withdrawal_days_milk: { gt: 0 } }] },
      orderBy: { name: "asc" },
    }));
  return (
    <>
      <PageHeader title="Periodos de retiro" subtitle="Productos veterinarios con tiempo de espera antes del consumo de carne o leche" />
      {rows.length > 0 && (
        <>
          <Panel title="Calculadora de retiro">
            <WithdrawalCalculator products={rows.map((p) => ({ id: p.id, name: p.name, meat: p.withdrawal_days_meat, milk: p.withdrawal_days_milk }))} />
          </Panel>
          <div style={{ height: 16 }} />
        </>
      )}
      <Panel>
        {rows.length === 0 ? (
          <EmptyState icon="leaf" title="Sin productos con periodo de retiro" text="Al registrar productos con días de retiro, el punto de venta advertirá al productor en cada venta." />
        ) : (
          <div className="app-table-wrap"><table className="app-table stack">
            <thead><tr><th>Producto</th><th>Registro SENASA</th><th className="num">Carne (días)</th><th className="num">Leche (días)</th></tr></thead>
            <tbody>{rows.map((p) => (
              <tr key={p.id}>
                <td data-label="Producto"><strong>{p.name}</strong><span className="app-sub">{p.sku}</span></td>
                <td data-label="Registro SENASA">{p.senasa_registration ?? "—"}</td>
                <td data-label="Carne (días)" className="num">{p.withdrawal_days_meat ?? 0}</td>
                <td data-label="Leche (días)" className="num">{p.withdrawal_days_milk ?? 0}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Panel>
    </>
  );
}
