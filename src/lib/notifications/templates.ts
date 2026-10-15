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
    default:
      throw new Error(`Plantilla desconocida: ${template}`);
  }
}
