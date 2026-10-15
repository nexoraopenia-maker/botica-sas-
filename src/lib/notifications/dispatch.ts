import "server-only";
import { platformDb } from "@/lib/db";
import { renderTemplate } from "@/lib/notifications/templates";
import { sendEmail, sendWhatsAppTemplate } from "@/lib/notifications/providers";
import type { HandlerResult } from "@/lib/sunat/emit";

/** Entrega una notificación (WhatsApp / email). Idempotente por estado. */
export async function dispatchNotification(notificationId: string, attempt: number): Promise<HandlerResult> {
  const db = platformDb();
  const n = await db.notification.findUnique({ where: { id: notificationId } });
  if (!n) return { status: "dead", error: "Notificación inexistente" };
  if (n.status !== "QUEUED" && n.status !== "FAILED") return { status: "done" };
  if (!n.recipient) {
    await db.notification.update({ where: { id: n.id }, data: { status: "SKIPPED", error: "Sin destinatario" } });
    return { status: "done" };
  }

  const msg = renderTemplate(n.template, n.payload as Record<string, unknown>);
  const res =
    n.channel === "WHATSAPP"
      ? await sendWhatsAppTemplate(n.recipient, msg.waTemplate, msg.waParams, msg.text)
      : await sendEmail(n.recipient, msg.subject, msg.text);

  await db.notification.update({
    where: { id: n.id },
    data: res.ok
      ? { status: "SENT", provider_message_id: res.providerMessageId ?? null, sent_at: new Date(), attempts: { increment: 1 }, error: null }
      : { status: "FAILED", error: res.error ?? "Error de envío", attempts: { increment: 1 } },
  });
  if (n.related_type === "reminder" && n.related_id) {
    await db.reminder.update({ where: { id: n.related_id }, data: { status: res.ok ? "SENT" : "FAILED" } });
  }
  if (res.ok) return { status: "done" };
  if (res.retryable && attempt < 5) return { status: "retry", delayMs: 60_000 * 2 ** attempt, error: res.error ?? "" };
  return { status: "dead", error: res.error ?? "Error definitivo" };
}
