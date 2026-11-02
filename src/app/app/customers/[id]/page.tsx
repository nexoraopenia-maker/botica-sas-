import Link from "next/link";
import { notFound } from "next/navigation";
import { requireTenant } from "@/lib/auth/session";
import { withTenant } from "@/lib/db";
import { MessageInbox } from "../../_components/message-inbox";
import { PageHeader, Panel, soles } from "../../_components/ui";

const UUID = /^[0-9a-f-]{36}$/i;

export default async function CustomerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireTenant({ permission: "customers.manage" });
  if (!UUID.test(id)) notFound();
  const db = { tenantId: ctx.tenantId, userId: ctx.userId };
  const data = await withTenant(db, async (tx) => {
    const customer = await tx.customer.findFirst({ where: { id, deleted_at: null } });
    if (!customer) return null;
    const [owners, docs] = await Promise.all([
      tx.owner.findMany({ where: { customer_id: id, deleted_at: null }, select: { whatsapp: true } }),
      tx.document.findMany({ where: { customer_id: id }, orderBy: { created_at: "desc" }, take: 10, select: { id: true, series: true, number: true, issue_date: true, total: true } }),
    ]);
    return { customer, owners, docs };
  });
  if (!data) notFound();
  const { customer: c, owners, docs } = data;
  return (
    <>
      <PageHeader title={c.name} subtitle={`${c.doc_type === "NO_DOC" ? "" : `${c.doc_type} ${c.doc_number} · `}${c.phone ?? "Sin teléfono"}`}
        actions={<Link href="/app/customers" className="app-btn">Volver</Link>} />
      <div className="app-grid-2">
        <MessageInbox ctx={db} phones={[c.phone, ...owners.map((o) => o.whatsapp)]} />
        <Panel title="Últimos comprobantes">
          {docs.length === 0 ? <p className="app-muted set-pad">Sin comprobantes.</p> : (
            <div className="app-table-wrap"><table className="app-table"><tbody>{docs.map((d) => (
              <tr key={d.id}><td>{d.series}-{d.number}</td><td>{d.issue_date.toISOString().slice(0, 10)}</td><td className="num">{soles(d.total)}</td></tr>
            ))}</tbody></table></div>
          )}
        </Panel>
      </div>
    </>
  );
}
