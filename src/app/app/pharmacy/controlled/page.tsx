import { requireTenant } from "@/lib/auth/session";
import { withTenant } from "@/lib/db";
import { EmptyState, PageHeader, Panel } from "../../_components/ui";

interface Row { id: bigint; occurred_at: Date; product: string; movement: string; quantity: string; balance: string; counterparty: string | null }

export default async function ControlledPage() {
  const ctx = await requireTenant({ permission: "pharmacy.controlled_log", module: "PHARMACY" });
  const rows = await withTenant({ tenantId: ctx.tenantId, userId: ctx.userId }, (tx) => tx.$queryRaw<Row[]>`
    SELECT l.id, l.occurred_at, p.name AS product, l.movement::text, l.quantity::text, l.balance::text, l.counterparty
      FROM controlled_substance_log l JOIN products p ON p.id = l.product_id
     ORDER BY l.id DESC LIMIT 300`);
  return (
    <>
      <PageHeader title="Libro de controlados" subtitle="Registro inmutable con saldo automático por producto" />
      <Panel>
        {rows.length === 0 ? (
          <EmptyState icon="book" title="Sin movimientos" text="Las compras y ventas de productos controlados se registran aquí automáticamente; el saldo nunca puede quedar negativo." />
        ) : (
          <div className="app-table-wrap"><table className="app-table">
            <thead><tr><th>Fecha</th><th>Producto</th><th>Movimiento</th><th className="num">Cantidad</th><th className="num">Saldo</th><th>Contraparte</th></tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={String(r.id)}>
                <td>{r.occurred_at.toLocaleString("es-PE", { timeZone: "America/Lima" })}</td>
                <td><strong>{r.product}</strong></td>
                <td><span className={`app-pill ${r.movement === "IN" ? "green" : r.movement === "OUT" ? "amber" : "gray"}`}>{r.movement === "IN" ? "Ingreso" : r.movement === "OUT" ? "Salida" : "Ajuste"}</span></td>
                <td className="num">{r.quantity}</td>
                <td className="num"><strong>{r.balance}</strong></td>
                <td>{r.counterparty ?? "—"}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Panel>
    </>
  );
}
