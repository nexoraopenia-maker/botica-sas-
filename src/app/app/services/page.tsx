import Link from "next/link";
import { requirePage } from "@/lib/auth/session";
import { withTenant } from "@/lib/db";
import { ORDER_STATUSES, orderCode, STATUS_LABEL, STATUS_TONE, type OrderStatus } from "@/lib/services/rules";
import { EmptyState, PageHeader, Panel, soles } from "../_components/ui";

export const metadata = { title: "Órdenes de servicio" };

export default async function ServicesPage({ searchParams }: { searchParams: Promise<{ estado?: string }> }) {
  const { estado } = await searchParams;
  const ctx = await requirePage({ permission: "services.manage", module: "WORKSHOP" });
  const status = ORDER_STATUSES.find((s) => s === estado);
  const orders = await withTenant({ tenantId: ctx.tenantId, userId: ctx.userId }, (tx) => tx.serviceOrder.findMany({
    // Por defecto, lo que está en taller: lo entregado se consulta aparte
    where: { deleted_at: null, status: status ?? { not: "DELIVERED" } },
    include: { customer: { select: { name: true, phone: true } } },
    orderBy: { created_at: "desc" }, take: 300,
  }));
  return (
    <>
      <PageHeader title="Órdenes de servicio" subtitle="Vehículos y piezas en taller"
        actions={<Link href="/app/services/new" className="app-btn primary">+ Recepcionar</Link>} />
      <div className="set-tabs" role="tablist" aria-label="Filtrar por estado">
        <Link href="/app/services" role="tab" aria-selected={!status} className={status ? "" : "on"}>En taller</Link>
        {ORDER_STATUSES.map((s) => <Link key={s} href={`/app/services?estado=${s}`} role="tab" aria-selected={status === s} className={status === s ? "on" : ""}>{STATUS_LABEL[s]}</Link>)}
      </div>
      <Panel>
        {orders.length === 0 ? (
          <EmptyState icon="wrench" title="Sin órdenes" text="Las órdenes que registre al recepcionar un vehículo o pieza aparecerán aquí."
            action={<Link href="/app/services/new" className="app-btn primary">+ Recepcionar</Link>} />
        ) : (
          <div className="app-table-wrap"><table className="app-table stack">
            <thead><tr><th>Orden</th><th>Vehículo o pieza</th><th>Cliente</th><th>Estado</th><th>Pago</th><th className="num">Saldo</th></tr></thead>
            <tbody>{orders.map((o) => (
              <tr key={o.id}>
                <td data-label="Orden"><Link className="app-link" href={`/app/services/${o.id}`}><strong>{orderCode(o.number)}</strong></Link><span className="app-sub">{o.created_at.toLocaleDateString("es-PE", { timeZone: "America/Lima" })}</span></td>
                <td data-label="Vehículo o pieza">{o.item_description}{o.plate && <span className="app-sub">{o.plate}</span>}</td>
                <td data-label="Cliente">{o.customer.name}{o.customer.phone && <span className="app-sub">{o.customer.phone}</span>}</td>
                <td data-label="Estado"><span className={`app-pill ${STATUS_TONE[o.status as OrderStatus]}`}>{STATUS_LABEL[o.status as OrderStatus]}</span></td>
                <td data-label="Pago">{o.payment_type === "CREDIT" ? "Crédito" : "Contado"}</td>
                <td data-label="Saldo" className="num">{soles(o.balance_due)}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Panel>
    </>
  );
}
