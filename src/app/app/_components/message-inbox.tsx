import { withTenant, type TenantDbContext } from "@/lib/db";
import { normalizePeruPhone } from "@/lib/notifications/providers";
import { renderTemplate } from "@/lib/notifications/templates";
import { Panel } from "./ui";

const STATUS: Record<string, { label: string; tone: string }> = {
  QUEUED: { label: "En cola", tone: "amber" }, SENT: { label: "Enviado", tone: "blue" }, DELIVERED: { label: "Entregado", tone: "green" },
  READ: { label: "Leído", tone: "green" }, FAILED: { label: "Falló", tone: "red" }, SKIPPED: { label: "Omitido", tone: "gray" },
};

function preview(template: string, payload: unknown): string {
  try {
    return renderTemplate(template, payload as Record<string, unknown>).text;
  } catch {
    return template;
  }
}

/** Bandeja de mensajes: historial de envíos de WhatsApp a los teléfonos de un cliente o paciente. */
export async function MessageInbox({ ctx, phones }: { ctx: TenantDbContext; phones: (string | null | undefined)[] }) {
  const variants = [...new Set(phones.flatMap((p) => {
    if (!p) return [];
    const e164 = normalizePeruPhone(p);
    return e164 ? [p, e164, e164.slice(1), e164.slice(3)] : [p];
  }))];
  const rows = variants.length === 0 ? [] : await withTenant(ctx, (tx) => tx.notification.findMany({
    where: { channel: "WHATSAPP", recipient: { in: variants } },
    orderBy: { created_at: "desc" }, take: 50,
    select: { id: true, template: true, payload: true, status: true, error: true, created_at: true, sent_at: true },
  }));
  return (
    <Panel title="Bandeja de mensajes">
      {variants.length === 0 ? <p className="app-muted set-pad">Sin número de WhatsApp registrado.</p>
        : rows.length === 0 ? <p className="app-muted set-pad">Aún no se han enviado mensajes a este contacto.</p>
        : (
          <ul className="wa-inbox">
            {rows.map((m) => {
              const st = STATUS[m.status] ?? { label: m.status, tone: "gray" };
              return (
                <li key={m.id}>
                  <p>{preview(m.template, m.payload)}</p>
                  <span className="wa-inbox-meta">
                    {(m.sent_at ?? m.created_at).toLocaleString("es-PE", { timeZone: "America/Lima", dateStyle: "short", timeStyle: "short" })}
                    {" "}<span className={`app-pill ${st.tone}`}>{st.label}</span>
                    {m.status === "FAILED" && m.error && <small title={m.error}> No se pudo entregar</small>}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
    </Panel>
  );
}
