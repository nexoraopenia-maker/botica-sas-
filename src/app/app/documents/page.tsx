import Link from "next/link";
import { requireTenant } from "@/lib/auth/session";
import { hasPermission } from "@/lib/auth/permissions";
import { D } from "@/lib/money";
import { withTenant } from "@/lib/db";
import { EmptyState, PageHeader, Panel, soles } from "../_components/ui";
import { SendToSunatButton } from "./send-button";

export const maxDuration = 60;

const DOC: Record<string, string> = { FACTURA: "Factura", BOLETA: "Boleta", NOTA_CREDITO: "Nota de crédito", NOTA_DEBITO: "Nota de débito" };
const ST: Record<string, [string, string]> = {
  PENDIENTE: ["Pendiente", "amber"], ENVIANDO: ["Enviando", "amber"], ACEPTADO: ["Aceptado", "green"], ACEPTADO_CON_OBS: ["Aceptado c/obs.", "green"],
  RECHAZADO: ["Rechazado", "red"], ERROR_REINTENTABLE: ["Reintentando", "amber"], ANULACION_PENDIENTE: ["Anulando", "amber"], ANULADO: ["Anulado", "gray"],
};

export default async function DocumentsPage({ searchParams }: { searchParams: Promise<{ nc?: string }> }) {
  const { nc } = await searchParams;
  const ctx = await requireTenant({ permission: "documents.read" });
  const canCredit = hasPermission(ctx.permissions, "documents.credit_note");
  const docs = await withTenant({ tenantId: ctx.tenantId, userId: ctx.userId }, (tx) =>
    tx.document.findMany({
      orderBy: { created_at: "desc" }, take: 100,
      include: { notes: { where: { doc_type: "NOTA_CREDITO" }, select: { series: true, number: true, total: true, status: true } }, refDocument: { select: { series: true, number: true } } },
    }));
  return (
    <>
      <PageHeader title="Comprobantes" subtitle="Facturas, boletas y notas con su estado ante SUNAT" />
      {nc && /^[A-Z0-9]{4}-\d+$/.test(nc) && (
        <p className="set-msg ok" role="status" style={{ marginBottom: 16 }}>Nota de crédito {nc} emitida. Se está enviando a SUNAT: su estado aparecerá aquí en unos segundos.</p>
      )}
      <Panel>
        {docs.length === 0 ? (
          <EmptyState icon="receipt" title="Sin comprobantes" text="Cuando registre ventas, aquí verá cada comprobante, su CDR y el estado de envío a SUNAT." />
        ) : (
          <div className="app-table-wrap"><table className="app-table stack">
            <thead><tr><th>Comprobante</th><th>Fecha</th><th>Cliente</th><th className="num">IGV</th><th className="num">Total</th><th>SUNAT</th><th aria-label="Acciones" /></tr></thead>
            <tbody>{docs.map((d) => {
              const [label, tone] = ST[d.status] ?? [d.status, "gray"];
              const credited = d.notes.reduce((a, n) => a.plus(n.total), D(0));
              const canIssueNote = canCredit && (ctx.branchIds.length === 0 || ctx.branchIds.includes(d.branch_id)) && (d.doc_type === "FACTURA" || d.doc_type === "BOLETA") && ["ACEPTADO", "ACEPTADO_CON_OBS"].includes(d.status) && credited.lt(d.total);
              return (
                <tr key={d.id}>
                  <td data-label="Comprobante"><strong>{d.series}-{d.number}</strong><span className="app-sub">{DOC[d.doc_type]}{d.refDocument ? ` de ${d.refDocument.series}-${d.refDocument.number}` : ""}</span>{d.notes.map((n) => <span key={`${n.series}-${n.number}`} className="app-sub">Nota {n.series}-{n.number}{n.status === "RECHAZADO" ? " (rechazada)" : ""}</span>)}</td>
                  <td data-label="Fecha">{d.issue_date.toISOString().slice(0, 10)} {d.issue_time.slice(0, 5)}</td>
                  <td data-label="Cliente">{d.customer_name}<span className="app-sub">{d.customer_doc_type === "NO_DOC" ? "Sin documento" : d.customer_doc_number}</span></td>
                  <td data-label="IGV" className="num">{soles(d.igv)}</td>
                  <td data-label="Total" className="num"><strong>{soles(d.total)}</strong></td>
                  <td data-label="SUNAT">
                    <span className={`app-pill ${tone}`} title={d.sunat_description ?? undefined}>{label}</span>
                    {d.sunat_description && <span className="app-sub doc-sunat-desc">{d.sunat_code ? `${d.sunat_code} · ` : ""}{d.sunat_description}</span>}
                  </td>
                  <td data-label="">
                    {["PENDIENTE", "ERROR_REINTENTABLE", "ENVIANDO"].includes(d.status) && <SendToSunatButton documentId={d.id} />}
                    {canIssueNote && <Link href={`/app/documents/${d.id}/credit-note`} className="app-btn">Nota de crédito</Link>}
                  </td>
                </tr>
              );
            })}</tbody>
          </table></div>
        )}
      </Panel>
    </>
  );
}
