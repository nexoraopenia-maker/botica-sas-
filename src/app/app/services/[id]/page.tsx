import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePage } from "@/lib/auth/session";
import { hasPermission } from "@/lib/auth/permissions";
import { withTenant } from "@/lib/db";
import { evidenceLinks } from "@/lib/services/orders";
import { orderCode, type OrderStatus } from "@/lib/services/rules";
import { MessageInbox } from "../../_components/message-inbox";
import { PageHeader, Panel, soles } from "../../_components/ui";
import { AddEvidence, PaymentForm, StatusControls, TermsForm } from "../_components/order-controls";

const METHOD: Record<string, string> = { EFECTIVO: "Efectivo", YAPE: "Yape", PLIN: "Plin", TARJETA: "Tarjeta", TRANSFERENCIA: "Transferencia" };

export default async function OrderPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ fotos_fallidas?: string }> }) {
  const { id } = await params;
  const { fotos_fallidas: failed } = await searchParams;
  const ctx = await requirePage({ permission: "services.manage", module: "WORKSHOP" });
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const db = { tenantId: ctx.tenantId, userId: ctx.userId };
  const o = await withTenant(db, (tx) => tx.serviceOrder.findFirst({
    where: { id, deleted_at: null },
    include: { customer: true, payments: { orderBy: { created_at: "desc" } } },
  }));
  if (!o) notFound();
  const photos = await evidenceLinks(ctx.tenantId, o.evidence_urls);
  const due = o.due_date?.toISOString().slice(0, 10) ?? null;
  const canCollect = o.payment_type === "CASH" || hasPermission(ctx.permissions, "receivables.manage");
  const delivered = o.status === "DELIVERED";
  return (
    <>
      <PageHeader title={orderCode(o.number)} subtitle={`${o.item_description}${o.plate ? ` · ${o.plate}` : ""} · ${o.customer.name}`}
        actions={<Link href="/app/services" className="app-btn">Volver</Link>} />
      {failed && <p className="set-msg bad" role="alert" style={{ marginBottom: 16 }}>La orden se registró, pero {failed} foto(s) no se pudieron subir. Vuelva a agregarlas abajo.</p>}
      <Panel title="Estado"><div className="set-pad">
        <StatusControls orderId={o.id} status={o.status as OrderStatus} paymentType={o.payment_type} total={o.total.toFixed(2)} balanceDue={o.balance_due.toFixed(2)} dueDate={due} />
      </div></Panel>
      <div style={{ height: 16 }} />
      <div className="app-grid-2">
        <div className="app-stack">
          <Panel title="Recepción">
            <dl className="svc-facts">
              <div><dt>Cliente</dt><dd>{o.customer.name} · {o.customer.doc_type} {o.customer.doc_number}</dd></div>
              <div><dt>WhatsApp</dt><dd>{o.customer.phone ?? "—"}{o.customer.phone && (o.customer.whatsapp_opt_in ? " · acepta recordatorios" : " · no acepta recordatorios")}</dd></div>
              {o.mileage !== null && <div><dt>Kilometraje</dt><dd>{o.mileage.toLocaleString("es-PE")} km</dd></div>}
              <div><dt>Trabajo solicitado</dt><dd>{o.problem}</dd></div>
              {o.notes && <div><dt>Observaciones</dt><dd>{o.notes}</dd></div>}
            </dl>
          </Panel>
          <Panel title={`Fotos (${photos.length})`}>
            {photos.length > 0 && (
              <div className="svc-photos set-pad">
                {photos.map((p, i) => p.url ? (
                  <a key={p.path} href={p.url} target="_blank" rel="noopener noreferrer" className="svc-photo">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={p.url} alt={`Foto ${i + 1} de la orden`} loading="lazy" />
                  </a>
                ) : <div key={p.path} className="svc-photo svc-photo-missing">No disponible</div>)}
              </div>
            )}
            <AddEvidence orderId={o.id} count={photos.length} />
          </Panel>
          <MessageInbox ctx={db} phones={[o.customer.phone]} />
        </div>
        <div className="app-stack">
          <Panel title={`Saldo: ${soles(o.balance_due)}`}>
            <p className="app-muted set-pad" style={{ marginBottom: 0 }}>Total {soles(o.total)} · {o.payment_type === "CREDIT" ? `Crédito, vence ${due}` : "Contado"}{o.invoice_number ? ` · Factura ${o.invoice_number}` : ""}</p>
            {o.balance_due.gt(0) && canCollect && <PaymentForm orderId={o.id} balance={o.balance_due.toFixed(2)} />}
            {o.balance_due.gt(0) && !canCollect && <p className="app-muted set-pad">Los cobros a crédito los registra administración en Cuentas por cobrar.</p>}
            {o.payments.length > 0 && (
              <div className="app-table-wrap"><table className="app-table"><tbody>{o.payments.map((p) => (
                <tr key={p.id}>
                  <td>{p.created_at.toLocaleString("es-PE", { timeZone: "America/Lima", dateStyle: "short", timeStyle: "short" })}</td>
                  <td>{METHOD[p.method] ?? p.method}{p.reference && <span className="app-sub">{p.reference}</span>}</td>
                  <td className="num">{soles(p.amount)}</td>
                </tr>
              ))}</tbody></table></div>
            )}
          </Panel>
          <Panel title="Condiciones de cobro">
            <TermsForm orderId={o.id} paymentType={o.payment_type} total={o.total.toFixed(2)} dueDate={due} invoice={o.invoice_number} delivered={delivered} />
          </Panel>
        </div>
      </div>
    </>
  );
}
