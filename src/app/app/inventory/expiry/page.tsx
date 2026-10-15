import { requireTenant } from "@/lib/auth/session";
import { withTenant } from "@/lib/db";

interface Row {
  batch_id: string;
  product_name: string;
  lot_code: string;
  expiry_date: Date;
  stock: string;
  stock_value: string;
  days_to_expiry: number;
  bucket: string;
}

const LABEL: Record<string, string> = { EXPIRED: "Vencido", D7: "≤ 7 días", D15: "≤ 15 días", D30: "≤ 30 días", D60: "≤ 60 días", D90: "≤ 90 días" };

export default async function ExpiryPage() {
  const ctx = await requireTenant({ permission: "inventory.read" });
  const rows = await withTenant({ tenantId: ctx.tenantId, userId: ctx.userId }, (tx) => tx.$queryRaw<Row[]>`
    SELECT batch_id, product_name, lot_code, expiry_date, stock::text, stock_value::text, days_to_expiry, bucket
      FROM app.v_batch_expiry WHERE bucket <> 'OK' ORDER BY expiry_date LIMIT 500`);

  return (
    <>
      <h1>Caducidad por lote</h1>
      <p>FEFO activo: los lotes vencidos están bloqueados para la venta. Los lotes a ≤ 60 días son candidatos a promoción.</p>
      <table>
        <thead><tr><th>Producto</th><th>Lote</th><th>Vence</th><th>Estado</th><th>Stock</th><th>Valor (S/)</th><th>Acción sugerida</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.batch_id}>
              <td>{r.product_name}</td>
              <td>{r.lot_code}</td>
              <td>{r.expiry_date.toISOString().slice(0, 10)}</td>
              <td><span className={`tag ${r.bucket === "EXPIRED" || r.bucket === "D7" ? "bad" : "warn"}`}>{LABEL[r.bucket] ?? r.bucket}</span></td>
              <td>{r.stock}</td>
              <td>{r.stock_value}</td>
              <td>{r.bucket === "EXPIRED" ? "Registrar merma / devolver a proveedor" : r.days_to_expiry <= 60 ? "Promoción / exhibición preferente" : "Monitorear"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
