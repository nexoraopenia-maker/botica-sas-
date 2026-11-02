/**
 * Plantillas. Para WhatsApp, los mensajes iniciados por el negocio exigen
 * plantillas aprobadas por Meta: `waTemplate` es el nombre registrado en
 * WhatsApp Manager y `waParams` el orden de variables {{1}}, {{2}}…
 */
export interface RenderedMessage {
  subject: string;
  text: string;
  waTemplate: string;
  waParams: string[];
}

type Payload = Record<string, unknown>;
const s = (v: unknown): string => (v === null || v === undefined ? "" : String(v));
const fmtDate = (v: unknown): string => {
  const d = s(v).slice(0, 10);
  const [y, m, day] = d.split("-");
  return y && m && day ? `${day}/${m}/${y}` : d;
};

export function renderTemplate(template: string, p: Payload): RenderedMessage {
  switch (template) {
    case "vaccine_due_soon":
      return {
        subject: `Recordatorio: vacuna de ${s(p.petName)}`,
        text: `Hola ${s(p.ownerName)}, te recordamos que ${s(p.petName)} tiene programada su vacuna ${s(p.vaccine)} (dosis ${s(p.dose)}) para el ${fmtDate(p.dueDate)}. Faltan ${s(p.daysLeft)} día(s). Te esperamos en ${s(p.clinic)}.`,
        waTemplate: "recordatorio_vacuna",
        waParams: [s(p.ownerName), s(p.petName), s(p.vaccine), fmtDate(p.dueDate), s(p.clinic)],
      };
    case "vaccine_due_today":
      return {
        subject: `Hoy toca la vacuna de ${s(p.petName)}`,
        text: `Hola ${s(p.ownerName)}, hoy ${fmtDate(p.dueDate)} corresponde la vacuna ${s(p.vaccine)} de ${s(p.petName)}. Te esperamos en ${s(p.clinic)}.`,
        waTemplate: "vacuna_hoy",
        waParams: [s(p.ownerName), s(p.petName), s(p.vaccine), s(p.clinic)],
      };
    case "payment_due_soon":
      return {
        subject: `Recordatorio de pago: orden ${s(p.order)}`,
        text: `Hola ${s(p.customerName)}, te recordamos que el saldo de S/ ${s(p.balance)} de tu orden ${s(p.order)} (${s(p.item)}) vence el ${fmtDate(p.dueDate)}. Gracias por tu preferencia, ${s(p.business)}.`,
        waTemplate: "recordatorio_cobranza",
        waParams: [s(p.customerName), s(p.balance), s(p.order), s(p.item), fmtDate(p.dueDate), s(p.business)],
      };
    case "stock_expiring":
      return {
        subject: `Lote por vencer: ${s(p.product)}`,
        text: `${s(p.clinic)}: el lote ${s(p.lot)} de ${s(p.product)} vence el ${fmtDate(p.expiryDate)} (${s(p.daysLeft)} día(s)). Stock actual: ${s(p.stock)}.`,
        waTemplate: "alerta_caducidad",
        waParams: [s(p.clinic), s(p.lot), s(p.product), fmtDate(p.expiryDate), s(p.stock)],
      };
    default:
      throw new Error(`Plantilla desconocida: ${template}`);
  }
}
