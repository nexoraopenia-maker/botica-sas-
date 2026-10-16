import Link from "next/link";
import { requireTenant } from "@/lib/auth/session";
import { hasPermission } from "@/lib/auth/permissions";
import { withTenant } from "@/lib/db";
import { limaNow } from "@/lib/time";
import { EmptyState, PageHeader, Panel, StatCard, soles } from "./_components/ui";
import { Icon, type IconName } from "./_components/icons";

interface Summary {
  sales_today: string;
  docs_today: number;
  sales_month: string;
  docs_month: number;
  products: number;
  expiring_30: number;
  expired: number;
  low_stock: number;
  sunat_pending: number;
  sunat_rejected: number;
  vaccines_7: number;
}

const STATUS: Record<string, { label: string; tone: string }> = {
  PENDIENTE: { label: "Pendiente", tone: "amber" },
  ENVIANDO: { label: "Enviando", tone: "amber" },
  ACEPTADO: { label: "Aceptado", tone: "green" },
  ACEPTADO_CON_OBS: { label: "Aceptado c/obs.", tone: "green" },
  RECHAZADO: { label: "Rechazado", tone: "red" },
  ERROR_REINTENTABLE: { label: "Reintentando", tone: "amber" },
  ANULACION_PENDIENTE: { label: "Anulando", tone: "amber" },
  ANULADO: { label: "Anulado", tone: "gray" },
};
const DOC_LABEL: Record<string, string> = { FACTURA: "Factura", BOLETA: "Boleta", NOTA_CREDITO: "Nota de crédito", NOTA_DEBITO: "Nota de débito" };

function greeting(): string {
  const hour = Number(limaNow().time.slice(0, 2));
  return hour < 12 ? "Buenos días" : hour < 19 ? "Buenas tardes" : "Buenas noches";
}

export default async function Dashboard() {
  const ctx = await requireTenant();
  const db = { tenantId: ctx.tenantId, userId: ctx.userId };
  const can = (p: Parameters<typeof hasPermission>[1]) => hasPermission(ctx.permissions, p);
  const vet = ctx.modules.has("VETERINARY");

  const { summary, recent, alerts, userName } = await withTenant(db, async (tx) => {
    const [s] = await tx.$queryRaw<Summary[]>`
      WITH sales AS (
        SELECT total, issue_date FROM documents
         WHERE doc_type IN ('FACTURA', 'BOLETA') AND status NOT IN ('RECHAZADO', 'ANULADO') AND deleted_at IS NULL
           AND issue_date >= date_trunc('month', app.lima_today())::date
      ),
      stock AS (
        SELECT p.id, p.min_stock, coalesce(sum(b.stock) FILTER (WHERE b.expiry_date IS NULL OR b.expiry_date >= app.lima_today()), 0) AS available
          FROM products p LEFT JOIN product_batches b ON b.product_id = p.id AND b.deleted_at IS NULL
         WHERE p.deleted_at IS NULL AND p.is_active AND NOT p.is_service
         GROUP BY p.id, p.min_stock
      )
      SELECT
        coalesce((SELECT sum(total) FROM sales WHERE issue_date = app.lima_today()), 0)::text AS sales_today,
        (SELECT count(*) FROM sales WHERE issue_date = app.lima_today())::int AS docs_today,
        coalesce((SELECT sum(total) FROM sales), 0)::text AS sales_month,
        (SELECT count(*) FROM sales)::int AS docs_month,
        (SELECT count(*) FROM stock)::int AS products,
        (SELECT count(*) FROM app.v_batch_expiry WHERE days_to_expiry BETWEEN 0 AND 30)::int AS expiring_30,
        (SELECT count(*) FROM app.v_batch_expiry WHERE days_to_expiry < 0)::int AS expired,
        (SELECT count(*) FROM stock WHERE min_stock > 0 AND available <= min_stock)::int AS low_stock,
        (SELECT count(*) FROM documents WHERE status IN ('PENDIENTE', 'ENVIANDO', 'ERROR_REINTENTABLE'))::int AS sunat_pending,
        (SELECT count(*) FROM documents WHERE status = 'RECHAZADO' AND created_at > now() - interval '30 days')::int AS sunat_rejected,
        (SELECT count(*) FROM (
           SELECT DISTINCT ON (pet_id, vaccine_id) next_due_at FROM pet_vaccinations
            WHERE deleted_at IS NULL ORDER BY pet_id, vaccine_id, applied_at DESC
         ) v WHERE v.next_due_at BETWEEN app.lima_today() AND app.lima_today() + 7)::int AS vaccines_7`;

    const recentDocs = await tx.document.findMany({
      orderBy: { created_at: "desc" },
      take: 6,
      select: { id: true, doc_type: true, series: true, number: true, customer_name: true, total: true, status: true, issue_date: true },
    });
    const notifications = await tx.notification.findMany({
      where: { user_id: ctx.userId, channel: "IN_APP", read_at: null },
      orderBy: { created_at: "desc" },
      take: 5,
      select: { id: true, template: true, payload: true, created_at: true },
    });
    const me = await tx.user.findUnique({ where: { id: ctx.userId }, select: { full_name: true } });
    return { summary: s!, recent: recentDocs, alerts: notifications, userName: me?.full_name?.split(" ")[0] ?? "" };
  });

  const quick: { href: string; label: string; icon: IconName; show: boolean }[] = [
    { href: "/app/pos", label: "Nueva venta", icon: "cart", show: can("pos.sell") },
    { href: "/app/purchases/ai", label: "Cargar factura con IA", icon: "sparkles", show: ctx.modules.has("AI_INVENTORY") && can("purchases.ai_ingest") },
    { href: "/app/inventory", label: "Ver inventario", icon: "box", show: can("inventory.read") },
    { href: "/app/vet/pets", label: "Pacientes", icon: "paw", show: vet && can("vet.records") },
    { href: "/app/pharmacy/prescriptions", label: "Registrar receta", icon: "rx", show: ctx.modules.has("PHARMACY") && can("pharmacy.dispense_rx") },
  ];

  return (
    <>
      <PageHeader
        title={`${greeting()}${userName ? `, ${userName}` : ""}`}
        subtitle={`Resumen de su negocio · ${new Date().toLocaleDateString("es-PE", { timeZone: "America/Lima", weekday: "long", day: "numeric", month: "long" })}`}
      />

      <div className="app-stats">
        <StatCard label="Ventas de hoy" value={soles(summary.sales_today)} hint={`${summary.docs_today} comprobantes`} icon="trend" tone="green" href="/app/documents" />
        <StatCard label="Ventas del mes" value={soles(summary.sales_month)} hint={`${summary.docs_month} comprobantes`} icon="chart" tone="blue" href="/app/documents" />
        <StatCard label="Lotes por vencer (30 días)" value={String(summary.expiring_30)} hint={summary.expired ? `${summary.expired} vencidos con stock` : "Sin lotes vencidos"} icon="clock" tone={summary.expired ? "red" : "amber"} href="/app/inventory/expiry" />
        <StatCard label="Productos con stock bajo" value={String(summary.low_stock)} hint={`${summary.products} productos activos`} icon="box" tone={summary.low_stock ? "amber" : "violet"} href="/app/inventory" />
        <StatCard label="Comprobantes SUNAT pendientes" value={String(summary.sunat_pending)} hint={summary.sunat_rejected ? `${summary.sunat_rejected} rechazados (30 días)` : "Sin rechazos en 30 días"} icon="receipt" tone={summary.sunat_rejected ? "red" : "blue"} href="/app/documents" />
        {vet && <StatCard label="Vacunas próximos 7 días" value={String(summary.vaccines_7)} hint="Recordatorios automáticos activos" icon="syringe" tone="violet" href="/app/vet/vaccines" />}
      </div>

      <div className="app-grid-2">
        <Panel title="Últimos comprobantes" action={<Link href="/app/documents" className="app-link">Ver todos</Link>}>
          {recent.length === 0 ? (
            <EmptyState icon="receipt" title="Aún no hay ventas" text="Los comprobantes emitidos desde el punto de venta aparecerán aquí con su estado ante SUNAT." />
          ) : (
            <div className="app-table-wrap">
              <table className="app-table">
                <thead><tr><th>Comprobante</th><th>Cliente</th><th>Fecha</th><th className="num">Total</th><th>SUNAT</th></tr></thead>
                <tbody>
                  {recent.map((d) => {
                    const st = STATUS[d.status] ?? { label: d.status, tone: "gray" };
                    return (
                      <tr key={d.id}>
                        <td><strong>{d.series}-{d.number}</strong><span className="app-sub">{DOC_LABEL[d.doc_type]}</span></td>
                        <td>{d.customer_name}</td>
                        <td>{d.issue_date.toISOString().slice(0, 10)}</td>
                        <td className="num">{soles(d.total)}</td>
                        <td><span className={`app-pill ${st.tone}`}>{st.label}</span></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        <div className="app-stack">
          <Panel title="Accesos rápidos">
            <div className="app-quick">
              {quick.filter((q) => q.show).map((q) => (
                <Link key={q.href} href={q.href} className="app-quick-item">
                  <Icon name={q.icon} size={18} /> {q.label}
                </Link>
              ))}
            </div>
          </Panel>
          <Panel title="Alertas">
            {alerts.length === 0 ? (
              <p className="app-muted">Sin alertas pendientes. Le avisaremos de lotes por vencer, stock bajo y vacunas.</p>
            ) : (
              <ul className="app-alerts">
                {alerts.map((a) => {
                  const p = a.payload as Record<string, unknown>;
                  const text =
                    a.template === "batch_expiry" ? `${String(p.product)} · lote ${String(p.lot)} vence ${String(p.expiryDate).slice(0, 10)}`
                    : a.template === "low_stock" ? `${String(p.product)} con stock bajo (${String(p.available)})`
                    : a.template === "sunat_rejection" ? `SUNAT rechazó ${String(p.label)}: ${String(p.description)}`
                    : a.template === "certificate_expiry" ? `El certificado digital vence en ${String(p.daysLeft)} días`
                    : a.template;
                  return <li key={a.id}><Icon name="alert" size={15} /> {text}</li>;
                })}
              </ul>
            )}
          </Panel>
        </div>
      </div>
    </>
  );
}
