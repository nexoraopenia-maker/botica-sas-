import Link from "next/link";
import { requirePage } from "@/lib/auth/session";
import { hasPermission } from "@/lib/auth/permissions";
import { withTenant } from "@/lib/db";
import { loadReceivables } from "@/lib/services/collections";
import type { TrafficLight } from "@/lib/services/rules";
import { EmptyState, PageHeader, Panel, StatCard, soles } from "../_components/ui";
import { CollectionReminders, ReceivablesTable } from "./_components/receivables-table";

export const metadata = { title: "Cuentas por cobrar" };
export const maxDuration = 60; // "Ejecutar ahora" entrega los recordatorios tras responder

const FILTERS: { key: TrafficLight; label: string; query: string }[] = [
  { key: "overdue", label: "Vencidas", query: "vencidas" },
  { key: "soon", label: "Por vencer", query: "por-vencer" },
  { key: "ok", label: "Al día", query: "al-dia" },
];

export default async function ReceivablesPage({ searchParams }: { searchParams: Promise<{ ver?: string }> }) {
  const { ver } = await searchParams;
  const ctx = await requirePage({ permission: "receivables.manage", module: "WORKSHOP" });
  const db = { tenantId: ctx.tenantId, userId: ctx.userId };
  const [data, wa] = await Promise.all([
    loadReceivables(db),
    withTenant(db, (tx) => tx.whatsappSettings.findUnique({ where: { tenant_id: ctx.tenantId }, select: { enabled: true } })),
  ]);
  const filter = FILTERS.find((f) => f.query === ver);
  const rows = filter ? data.rows.filter((r) => r.light === filter.key) : data.rows;
  const stat = (k: TrafficLight) => `${data.totals[k].count} crédito${data.totals[k].count === 1 ? "" : "s"}`;
  return (
    <>
      <PageHeader title="Cuentas por cobrar" subtitle="Órdenes a crédito con saldo pendiente" />
      <div className="app-stats">
        <StatCard label="Vencidas" value={soles(data.totals.overdue.amount)} hint={stat("overdue")} icon="alert" tone="red" href="/app/receivables?ver=vencidas" />
        <StatCard label={`Por vencer (${data.soonDays} días)`} value={soles(data.totals.soon.amount)} hint={stat("soon")} icon="clock" tone="amber" href="/app/receivables?ver=por-vencer" />
        <StatCard label="Al día" value={soles(data.totals.ok.amount)} hint={stat("ok")} icon="coins" tone="green" href="/app/receivables?ver=al-dia" />
      </div>
      <div className="set-tabs" role="tablist" aria-label="Filtrar por vencimiento">
        <Link href="/app/receivables" role="tab" aria-selected={!filter} className={filter ? "" : "on"}>Todas ({data.rows.length})</Link>
        {FILTERS.map((f) => <Link key={f.key} href={`/app/receivables?ver=${f.query}`} role="tab" aria-selected={filter?.key === f.key} className={filter?.key === f.key ? "on" : ""}>{f.label} ({data.totals[f.key].count})</Link>)}
      </div>
      <Panel>
        {rows.length === 0 ? (
          <EmptyState icon="coins" title={filter ? `Sin créditos en "${filter.label}"` : "Sin cuentas por cobrar"} text="Las órdenes de servicio a crédito con saldo pendiente aparecerán aquí." />
        ) : <ReceivablesTable rows={rows} canOpenOrders={hasPermission(ctx.permissions, "services.manage")} />}
      </Panel>
      <div style={{ height: 16 }} />
      <Panel title="Recordatorios de cobranza">
        <CollectionReminders soonDays={data.soonDays} canRun={!ctx.impersonation?.readOnly} canSend={!!wa?.enabled && ctx.modules.has("WHATSAPP")} />
      </Panel>
    </>
  );
}
