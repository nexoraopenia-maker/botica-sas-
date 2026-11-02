import "server-only";
import { platformDb, withTenant, type TenantDbContext } from "@/lib/db";
import { renderTemplate } from "@/lib/notifications/templates";
import { limaNow } from "@/lib/time";
import { daysBetween, orderCode, trafficLight, type TrafficLight } from "./rules";

export interface Receivable {
  id: string; code: string; item: string; plate: string | null; invoice: string | null; status: string;
  customerId: string; customerName: string; customerDoc: string; phone: string | null; optIn: boolean;
  total: string; balance: string; dueDate: string; light: TrafficLight; label: string; days: number;
}

export interface ReceivablesData {
  soonDays: number;
  today: string;
  rows: Receivable[];
  totals: Record<TrafficLight, { amount: string; count: number }>;
}

/** Créditos con saldo pendiente, del vencimiento más antiguo al más lejano. */
export async function loadReceivables(ctx: TenantDbContext): Promise<ReceivablesData> {
  const today = limaNow().date;
  return withTenant(ctx, async (tx) => {
    const [cfg, orders] = await Promise.all([
      tx.whatsappSettings.findUnique({ where: { tenant_id: ctx.tenantId }, select: { reminder_days: true } }),
      tx.serviceOrder.findMany({
        where: { deleted_at: null, payment_type: "CREDIT", balance_due: { gt: 0 } },
        include: { customer: { select: { id: true, name: true, doc_number: true, phone: true, whatsapp_opt_in: true } } },
        orderBy: { due_date: "asc" },
        take: 1000,
      }),
    ]);
    const soonDays = cfg?.reminder_days ?? 3;
    const cents = { overdue: 0, soon: 0, ok: 0 };
    const counts = { overdue: 0, soon: 0, ok: 0 };
    const rows = orders.map((o): Receivable => {
      const dueDate = o.due_date!.toISOString().slice(0, 10);
      const t = trafficLight(dueDate, today, soonDays);
      cents[t.light] += Math.round(o.balance_due.toNumber() * 100);
      counts[t.light]++;
      return {
        id: o.id, code: orderCode(o.number), item: o.item_description, plate: o.plate, invoice: o.invoice_number, status: o.status,
        customerId: o.customer.id, customerName: o.customer.name, customerDoc: o.customer.doc_number, phone: o.customer.phone, optIn: o.customer.whatsapp_opt_in,
        total: o.total.toFixed(2), balance: o.balance_due.toFixed(2), dueDate, light: t.light, label: t.label, days: t.days,
      };
    });
    const totals = Object.fromEntries((["overdue", "soon", "ok"] as const).map((k) => [k, { amount: (cents[k] / 100).toFixed(2), count: counts[k] }])) as ReceivablesData["totals"];
    return { soonDays, today, rows, totals };
  });
}

export interface CollectionItem { label: string; recipient: string; text: string; isNew: boolean }
export interface CollectionScan { dryRun: boolean; tenants: number; queued: number; skippedNoConsent: number; items: CollectionItem[] }

const dedupeKey = (orderId: string, due: string) => `collect:${orderId}:${due}`;

/**
 * Recordatorios de cobranza por WhatsApp de créditos a punto de vencer (0 a N días, según la configuración del negocio).
 * Solo a clientes que aceptaron recibirlos. dryRun = true no escribe nada.
 * Idempotente: un aviso por orden y fecha de vencimiento; si el vencimiento cambia, corresponde uno nuevo.
 */
export async function scanCollections(opts: { tenantId?: string; dryRun: boolean }): Promise<CollectionScan> {
  const db = platformDb();
  const today = limaNow().date;
  const tenants = await db.whatsappSettings.findMany({
    where: {
      enabled: true,
      ...(opts.tenantId ? { tenant_id: opts.tenantId } : {}),
      tenant: {
        status: { in: ["TRIAL", "ACTIVE"] }, deleted_at: null,
        AND: [{ modules: { some: { module: "WHATSAPP", enabled: true } } }, { modules: { some: { module: "WORKSHOP", enabled: true } } }],
      },
    },
    include: { tenant: { select: { trade_name: true, legal_name: true } } },
  });

  const items: CollectionItem[] = [];
  let queued = 0, skippedNoConsent = 0;

  for (const cfg of tenants) {
    const business = cfg.tenant.trade_name ?? cfg.tenant.legal_name;
    const limit = new Date(`${today}T00:00:00Z`);
    limit.setUTCDate(limit.getUTCDate() + cfg.reminder_days);
    const orders = await db.serviceOrder.findMany({
      where: {
        tenant_id: cfg.tenant_id, deleted_at: null, payment_type: "CREDIT", balance_due: { gt: 0 },
        due_date: { gte: new Date(`${today}T00:00:00Z`), lte: limit },
      },
      include: { customer: { select: { name: true, phone: true, whatsapp_opt_in: true } } },
      orderBy: { due_date: "asc" },
    });
    if (orders.length === 0) continue;
    const sent = new Set((await db.notification.findMany({
      where: { tenant_id: cfg.tenant_id, dedupe_key: { in: orders.map((o) => dedupeKey(o.id, o.due_date!.toISOString().slice(0, 10))) } },
      select: { dedupe_key: true },
    })).map((n) => n.dedupe_key));

    for (const o of orders) {
      if (!o.customer.whatsapp_opt_in || !o.customer.phone) { skippedNoConsent++; continue; }
      const due = o.due_date!.toISOString().slice(0, 10);
      const key = dedupeKey(o.id, due);
      const payload = {
        customerName: o.customer.name, balance: o.balance_due.toFixed(2), order: orderCode(o.number), item: o.item_description,
        dueDate: due, daysLeft: daysBetween(today, due), business,
      };
      const isNew = !sent.has(key);
      items.push({ label: `${orderCode(o.number)} · ${o.customer.name}`, recipient: o.customer.phone, text: renderTemplate("payment_due_soon", payload).text, isNew });
      if (opts.dryRun || !isNew) continue;
      const created = await db.$transaction(async (tx) => {
        const res = await tx.notification.createMany({
          data: [{ tenant_id: cfg.tenant_id, channel: "WHATSAPP", template: "payment_due_soon", recipient: o.customer.phone, payload, dedupe_key: key, related_type: "service_order", related_id: o.id }],
          skipDuplicates: true,
        });
        if (res.count === 0) return false; // otro proceso lo encoló primero
        const n = await tx.notification.findUniqueOrThrow({ where: { tenant_id_dedupe_key: { tenant_id: cfg.tenant_id, dedupe_key: key } } });
        await tx.outboxEvent.create({
          data: {
            tenant_id: cfg.tenant_id, aggregate_type: "notification", aggregate_id: n.id, event_type: "notification.send",
            payload: { notificationId: n.id }, dedupe_key: `notification.send:${n.id}`,
          },
        });
        return true;
      });
      if (created) queued++;
    }
  }
  return { dryRun: opts.dryRun, tenants: tenants.length, queued, skippedNoConsent, items };
}
