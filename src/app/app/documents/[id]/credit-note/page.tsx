import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePage } from "@/lib/auth/session";
import { hasPermission } from "@/lib/auth/permissions";
import { loadCreditNoteContext } from "@/lib/sunat/credit-note";
import { EmptyState, PageHeader, Panel, soles } from "../../../_components/ui";
import { CreditNoteForm } from "./credit-note-form";

export const metadata = { title: "Nueva nota de crédito" };
// La firma y el envío a SUNAT corren tras responder (after) dentro de la misma función
export const maxDuration = 60;

const STATUS: Record<string, string> = { ACEPTADO: "Aceptada", ACEPTADO_CON_OBS: "Aceptada con observaciones", RECHAZADO: "Rechazada por SUNAT", PENDIENTE: "Pendiente", ENVIANDO: "Enviando", ERROR_REINTENTABLE: "Reintentando" };

export default async function CreditNotePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const ctx = await requirePage({ permission: "documents.credit_note" });
  const data = await loadCreditNoteContext({ tenantId: ctx.tenantId, userId: ctx.userId }, id);
  if (!data) notFound();
  const { document: d } = data;
  await requirePage({ permission: "documents.credit_note", branchId: d.branchId }); // un usuario de otra sucursal no devuelve aquí
  const canManageSeries = hasPermission(ctx.permissions, "settings.manage");
  return (
    <>
      <PageHeader title={`Nota de crédito de ${d.label}`} subtitle={`${d.customerName} · ${d.customerDoc} · ${d.issueDate} · Total ${soles(d.total)}`}
        actions={<Link href="/app/documents" className="app-btn">Volver a Comprobantes</Link>} />
      {data.hasRejectedNote && (
        <p className="set-msg bad" role="alert" style={{ marginBottom: 16 }}>
          SUNAT rechazó una nota de este comprobante. Lo que ella devolvió sigue contado aquí, porque ya repuso stock y movió dinero: no se puede devolver dos veces. Revise el caso con su contador.
        </p>
      )}
      {data.priorNotes.length > 0 && (
        <>
          <Panel title="Notas anteriores">
            <div className="app-table-wrap"><table className="app-table"><tbody>{data.priorNotes.map((n) => (
              <tr key={n.label}><td><strong>{n.label}</strong></td><td>{STATUS[n.status] ?? n.status}</td><td className="num">{soles(n.total)}</td></tr>
            ))}</tbody></table></div>
          </Panel>
          <div style={{ height: 16 }} />
        </>
      )}
      <Panel>
        {data.blocker ? <EmptyState icon="receipt" title="No se puede emitir" text={data.blocker} action={<Link href="/app/documents" className="app-btn">Volver</Link>} />
          : data.series.length === 0 ? (
            <EmptyState icon="receipt" title="Falta una serie de notas de crédito" text={canManageSeries ? `Cree en Configuración una serie de nota de crédito que empiece con ${d.label[0]} para esta sucursal.` : `Pida a un administrador que cree una serie de nota de crédito que empiece con ${d.label[0]} para esta sucursal.`}
              action={canManageSeries ? <Link href="/app/settings?tab=series" className="app-btn primary">Ir a series</Link> : undefined} />
          ) : <CreditNoteForm data={data} />}
      </Panel>
    </>
  );
}
