import Link from "next/link";
import { requireTenant } from "@/lib/auth/session";
import { withTenant } from "@/lib/db";
import { EmptyState, PageHeader, Panel, soles } from "../_components/ui";

const SRC: Record<string, string> = { MANUAL: "Manual", AI_IMAGE: "IA (foto)", AI_PDF: "IA (PDF)", XML_UBL: "XML" };

export default async function PurchasesPage() {
  const ctx = await requireTenant({ permission: "purchases.manage" });
  const rows = await withTenant({ tenantId: ctx.tenantId, userId: ctx.userId }, (tx) =>
    tx.purchase.findMany({ where: { deleted_at: null }, include: { supplier: true }, orderBy: { issue_date: "desc" }, take: 200 }));
  return (
    <>
      <PageHeader title="Compras" subtitle="Ingresos de mercadería con lote y vencimiento"
        actions={ctx.modules.has("AI_INVENTORY") ? <Link href="/app/purchases/ai" className="app-btn primary">Cargar factura con IA</Link> : undefined} />
      <Panel>
        {rows.length === 0 ? (
          <EmptyState icon="truck" title="Sin compras registradas" text="Cada compra crea o actualiza los lotes del inventario y su kardex." />
        ) : (
          <div className="app-table-wrap"><table className="app-table">
            <thead><tr><th>Comprobante</th><th>Proveedor</th><th>Fecha</th><th>Origen</th><th className="num">Total</th></tr></thead>
            <tbody>{rows.map((p) => (
              <tr key={p.id}>
                <td><strong>{p.series}-{p.number}</strong></td>
                <td>{p.supplier.legal_name}<span className="app-sub">RUC {p.supplier.ruc}</span></td>
                <td>{p.issue_date.toISOString().slice(0, 10)}</td>
                <td><span className="app-pill gray">{SRC[p.source]}</span></td>
                <td className="num">{p.currency === "PEN" ? soles(p.total) : `US$ ${p.total.toFixed(2)}`}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Panel>
    </>
  );
}
