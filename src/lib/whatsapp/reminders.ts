import "server-only";
import { platformDb } from "@/lib/db";
import { limaNow } from "@/lib/time";
import { renderTemplate } from "@/lib/notifications/templates";

export interface ReminderItem {
  kind: "vaccine" | "stock";
  label: string;
  recipient: string;
  text: string;
  /** false = ya se había enviado antes (no se repite) */
  isNew: boolean;
}

export interface ReminderScan {
  dryRun: boolean;
  tenants: number;
  queued: number;
  items: ReminderItem[];
}

interface VaccineRow {
  vaccination_id: string; tenant_id: string; pet_id: string; pet_name: string; owner_name: string; whatsapp: string;
  vaccine: string; dose: number; due: Date; days_left: number; clinic: string; sent: boolean;
}
interface StockRow {
  batch_id: string; product: string; lot: string; expiry: Date; days_left: number; stock: string; sent: boolean;
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Recordatorios por WhatsApp: vacunas y caducidad de stock a N días (3 por defecto, configurable).
 *   dryRun = true  → solo informa qué se enviaría (simulación).
 *   dryRun = false → encola en notifications + outbox; el worker los entrega con las credenciales del negocio.
 * Idempotente: reminders y notifications tienen claves únicas compartidas con el job de pg_cron,
 * así que ejecutarlo varias veces (o junto con pg_cron) no duplica mensajes.
 */
export async function scanReminders(opts: { tenantId?: string; dryRun: boolean }): Promise<ReminderScan> {
  const db = platformDb();
  const today = limaNow().date;
  const tenants = await db.whatsappSettings.findMany({
    where: {
      enabled: true,
      ...(opts.tenantId ? { tenant_id: opts.tenantId } : {}),
      tenant: { status: { in: ["TRIAL", "ACTIVE"] }, deleted_at: null, modules: { some: { module: "WHATSAPP", enabled: true } } },
    },
    include: { tenant: { select: { trade_name: true, legal_name: true, contact_phone: true } } },
  });

  const items: ReminderItem[] = [];
  let queued = 0;

  for (const cfg of tenants) {
    const clinic = cfg.tenant.trade_name ?? cfg.tenant.legal_name;
    const days = cfg.reminder_days;

    const vaccines = await db.$queryRaw<VaccineRow[]>`
      SELECT l.id AS vaccination_id, l.tenant_id, l.pet_id, p.name AS pet_name, o.full_name AS owner_name, o.whatsapp,
             vc.name AS vaccine, l.dose_number AS dose, l.next_due_at AS due,
             (l.next_due_at - ${today}::date)::int AS days_left,
             ${clinic} AS clinic,
             EXISTS (SELECT 1 FROM reminders r WHERE r.pet_vaccination_id = l.id AND r.offset_days = ${days}::int AND r.channel = 'WHATSAPP') AS sent
        FROM (SELECT DISTINCT ON (pv.pet_id, pv.vaccine_id) pv.*
                FROM pet_vaccinations pv
               WHERE pv.tenant_id = ${cfg.tenant_id}::uuid AND pv.deleted_at IS NULL
               ORDER BY pv.pet_id, pv.vaccine_id, pv.applied_at DESC, pv.created_at DESC) l
        JOIN pets p ON p.id = l.pet_id AND p.deleted_at IS NULL AND p.deceased_at IS NULL
        JOIN owners o ON o.id = p.owner_id AND o.deleted_at IS NULL AND o.notify_whatsapp AND o.whatsapp IS NOT NULL
        JOIN vaccine_catalog vc ON vc.id = l.vaccine_id
       WHERE l.next_due_at BETWEEN ${today}::date AND ${today}::date + ${days}::int`;

    for (const v of vaccines) {
      const payload = { petName: v.pet_name, ownerName: v.owner_name, vaccine: v.vaccine, dose: v.dose, dueDate: iso(v.due), daysLeft: v.days_left, clinic };
      items.push({ kind: "vaccine", label: `${v.pet_name} · ${v.vaccine}`, recipient: v.whatsapp, text: renderTemplate("vaccine_due_soon", payload).text, isNew: !v.sent });
      if (opts.dryRun || v.sent) continue;
      const created = await db.$transaction(async (tx) => {
        const reminder = await tx.reminder.createMany({
          data: [{ tenant_id: v.tenant_id, pet_id: v.pet_id, pet_vaccination_id: v.vaccination_id, due_date: v.due, offset_days: days, channel: "WHATSAPP" }],
          skipDuplicates: true,
        });
        if (reminder.count === 0) return false; // otro proceso lo encoló primero
        const row = await tx.reminder.findUniqueOrThrow({
          where: { pet_vaccination_id_offset_days_channel: { pet_vaccination_id: v.vaccination_id, offset_days: days, channel: "WHATSAPP" } },
        });
        const n = await tx.notification.create({
          data: {
            tenant_id: v.tenant_id, channel: "WHATSAPP", template: "vaccine_due_soon", recipient: v.whatsapp,
            payload: { reminderId: row.id, ...payload }, dedupe_key: `vacc:${v.vaccination_id}:${days}:WHATSAPP`,
            related_type: "reminder", related_id: row.id,
          },
        });
        await tx.reminder.update({ where: { id: row.id }, data: { notification_id: n.id } });
        await tx.outboxEvent.create({
          data: {
            tenant_id: v.tenant_id, aggregate_type: "notification", aggregate_id: n.id, event_type: "notification.send",
            payload: { notificationId: n.id }, dedupe_key: `notification.send:${n.id}`,
          },
        });
        return true;
      });
      if (created) queued++;
    }

    const recipient = cfg.alert_phone ?? cfg.tenant.contact_phone;
    if (!recipient) continue;
    const stock = await db.$queryRaw<StockRow[]>`
      SELECT b.batch_id, b.product_name AS product, b.lot_code AS lot, b.expiry_date AS expiry, b.days_to_expiry::int AS days_left, b.stock::text AS stock,
             EXISTS (SELECT 1 FROM notifications n WHERE n.tenant_id = ${cfg.tenant_id}::uuid AND n.dedupe_key = 'wa-stock:' || b.batch_id || ':' || b.expiry_date) AS sent
        FROM app.v_batch_expiry b
       WHERE b.tenant_id = ${cfg.tenant_id}::uuid AND b.days_to_expiry BETWEEN 0 AND ${days}::int`;

    for (const b of stock) {
      const payload = { product: b.product, lot: b.lot, expiryDate: iso(b.expiry), daysLeft: b.days_left, stock: b.stock, clinic };
      items.push({ kind: "stock", label: `${b.product} · lote ${b.lot}`, recipient, text: renderTemplate("stock_expiring", payload).text, isNew: !b.sent });
      if (opts.dryRun || b.sent) continue;
      const dedupe = `wa-stock:${b.batch_id}:${iso(b.expiry)}`;
      const created = await db.$transaction(async (tx) => {
        const res = await tx.notification.createMany({
          data: [{ tenant_id: cfg.tenant_id, channel: "WHATSAPP", template: "stock_expiring", recipient, payload, dedupe_key: dedupe, related_type: "product_batch", related_id: b.batch_id }],
          skipDuplicates: true,
        });
        if (res.count === 0) return false;
        const n = await tx.notification.findUniqueOrThrow({ where: { tenant_id_dedupe_key: { tenant_id: cfg.tenant_id, dedupe_key: dedupe } } });
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
  return { dryRun: opts.dryRun, tenants: tenants.length, queued, items };
}
