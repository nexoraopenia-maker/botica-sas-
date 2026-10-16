import { requireTenant } from "@/lib/auth/session";
import { withTenant } from "@/lib/db";
import { EmptyState, PageHeader, Panel, soles } from "../_components/ui";

const DOC: Record<string, string> = { FACTURA: "Factura", BOLETA: "Boleta", NOTA_CREDITO: "Nota de crédito", NOTA_DEBITO: "Nota de débito" };
const ST: Record<string, [string, string]> = {
  PENDIENTE: ["Pendiente", "amber"], ENVIANDO: ["Enviando", "amber"], ACEPTADO: ["Aceptado", "green"], ACEPTADO_CON_OBS: ["Aceptado c/obs.", "green"],
  RECHAZADO: ["Rechazado", "red"], ERROR_REINTENTABLE: ["Reintentando", "amber"], ANULACION_PENDIENTE: ["Anulando", "amber"], ANULADO: ["Anulado", "gray"],
};

export default async function DocumentsPage() {
  const ctx = await requireTenant({ permission: "documents.read" });
  const docs = await withTenant({ tenantId: ctx.tenantId, userId: ctx.userId }, (tx) =>
    tx.document.findMany({ orderBy: { created_at: "desc" }, take: 100 }));
  return (
    <>
      <PageHeader title="Comprobantes" subtitle="Facturas, boletas y notas con su estado ante SUNAT" />
      <Panel>
        {docs.length === 0 ? (
          <EmptyState icon="receipt" title="Sin comprobantes" text="Cuando registre ventas, aquí verá cada comprobante, su CDR y el estado de envío a SUNAT." />
        ) : (
          <div className="app-table-wrap"><table className="app-table">
            <thead><tr><th>Comprobante</th><th>Fecha</th><th>Cliente</th><th className="num">IGV</th><th className="num">Total</th><th>SUNAT</th></tr></thead>
            <tbody>{docs.map((d) => {
              const [label, tone] = ST[d.status] ?? [d.status, "gray"];
              return (
                <tr key={d.id}>
                  <td><strong>{d.series}-{d.number}</strong><span className="app-sub">{DOC[d.doc_type]}</span></td>
                  <td>{d.issue_date.toISOString().slice(0, 10)} {d.issue_time.slice(0, 5)}</td>
                  <td>{d.customer_name}<span className="app-sub">{d.customer_doc_type === "NO_DOC" ? "Sin documento" : d.customer_doc_number}</span></td>
                  <td className="num">{soles(d.igv)}</td>
                  <td className="num"><strong>{soles(d.total)}</strong></td>
                  <td><span className={`app-pill ${tone}`} title={d.sunat_description ?? undefined}>{label}</span></td>
                </tr>
              );
            })}</tbody>
          </table></div>
        )}
      </Panel>
    </>
  );
}
