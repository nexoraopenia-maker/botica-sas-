import { requireTenant } from "@/lib/auth/session";
import { withTenant } from "@/lib/db";
import { EmptyState, PageHeader, Panel, soles } from "../../_components/ui";

interface Row {
  batch_id: string; product_name: string; lot_code: string; expiry_date: Date; stock: string; stock_value: string;
  days_to_expiry: number; bucket: string;
}

const LABEL: Record<string, [string, string]> = {
  EXPIRED: ["Vencido", "red"], D7: ["≤ 7 días", "red"], D15: ["≤ 15 días", "amber"], D30: ["≤ 30 días", "amber"],
  D60: ["≤ 60 días", "blue"], D90: ["≤ 90 días", "gray"],
};

export default async function ExpiryPage() {
  const ctx = await requireTenant({ permission: "inventory.read" });
  const rows = await withTenant({ tenantId: ctx.tenantId, userId: ctx.userId }, (tx) => tx.$queryRaw<Row[]>`
    SELECT batch_id, product_name, lot_code, expiry_date, stock::text, stock_value::text, days_to_expiry, bucket
      FROM app.v_batch_expiry WHERE bucket <> 'OK' ORDER BY expiry_date LIMIT 500`);

  return (
    <>
      <PageHeader title="Caducidad por lote" subtitle="FEFO activo: los lotes vencidos están bloqueados para la venta; los de ≤ 60 días son candidatos a promoción" />
      <Panel>
        {rows.length === 0 ? (
          <EmptyState icon="clock" title="Ningún lote por vencer" text="No hay lotes con stock que venzan en los próximos 90 días." />
        ) : (
          <div className="app-table-wrap"><table className="app-table">
            <thead><tr><th>Producto</th><th>Lote</th><th>Vence</th><th>Estado</th><th className="num">Stock</th><th className="num">Valor</th><th>Acción sugerida</th></tr></thead>
            <tbody>{rows.map((r) => {
              const [label, tone] = LABEL[r.bucket] ?? [r.bucket, "gray"];
              return (
                <tr key={r.batch_id}>
                  <td><strong>{r.product_name}</strong></td>
                  <td>{r.lot_code}</td>
                  <td>{r.expiry_date.toISOString().slice(0, 10)}</td>
                  <td><span className={`app-pill ${tone}`}>{label}</span></td>
                  <td className="num">{r.stock}</td>
                  <td className="num">{soles(r.stock_value)}</td>
                  <td>{r.bucket === "EXPIRED" ? "Registrar merma o devolver al proveedor" : r.days_to_expiry <= 60 ? "Promoción o exhibición preferente" : "Monitorear"}</td>
                </tr>
              );
            })}</tbody>
          </table></div>
        )}
      </Panel>
    </>
  );
}
