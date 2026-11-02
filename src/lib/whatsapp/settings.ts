import "server-only";
import { z } from "zod";
import { platformDb, type TenantDbContext } from "@/lib/db";
import { audit } from "@/lib/audit";
import { DomainError } from "@/lib/result";
import { loadWhatsappToken, storeWhatsappToken } from "@/lib/platform/tenant-secrets";
import { normalizePeruPhone, type TenantWhatsapp } from "@/lib/notifications/providers";

/*
 * WhatsApp por negocio. Los datos no sensibles viven en whatsapp_settings (RLS por tenant);
 * el token va cifrado en tenant_secrets, que el rol de runtime no puede leer: por eso estas
 * operaciones usan el cliente de plataforma, SIEMPRE con el tenant_id de la sesión verificada.
 */

export interface WhatsappStatus {
  provider: "META_CLOUD" | "WEB_QR";
  wabaId: string;
  phoneNumberId: string;
  enabled: boolean;
  reminderDays: number;
  alertPhone: string;
  tokenMask: string | null;
  tokenUpdatedAt: string | null;
  bridgeAvailable: boolean;
}

export async function getWhatsappStatus(tenantId: string, bridgeAvailable: boolean): Promise<WhatsappStatus> {
  const db = platformDb();
  const [row, token] = await Promise.all([
    db.whatsappSettings.findUnique({ where: { tenant_id: tenantId } }),
    db.tenantSecret.findFirst({
      where: { tenant_id: tenantId, kind: "WHATSAPP_TOKEN", is_active: true },
      select: { fingerprint: true, created_at: true }, // sin ciphertext
    }),
  ]);
  return {
    provider: row?.provider ?? "META_CLOUD",
    wabaId: row?.waba_id ?? "",
    phoneNumberId: row?.phone_number_id ?? "",
    enabled: row?.enabled ?? false,
    reminderDays: row?.reminder_days ?? 3,
    alertPhone: row?.alert_phone ?? "",
    tokenMask: token?.fingerprint ?? null,
    tokenUpdatedAt: token?.created_at.toISOString() ?? null,
    bridgeAvailable,
  };
}

const digits = (label: string) => z.string().trim().regex(/^\d{5,30}$/, `${label}: solo números`);

export const whatsappSettingsSchema = z.object({
  provider: z.enum(["META_CLOUD", "WEB_QR"]),
  wabaId: digits("WABA ID").or(z.literal("")).default(""),
  phoneNumberId: digits("Phone Number ID").or(z.literal("")).default(""),
  /** Vacío = conservar el token ya guardado */
  token: z.string().trim().max(1000).optional(),
  enabled: z.boolean(),
  reminderDays: z.number().int().min(1).max(30),
  alertPhone: z.string().trim().max(20).optional(),
});

export async function saveWhatsappSettings(ctx: TenantDbContext, raw: z.input<typeof whatsappSettingsSchema>): Promise<void> {
  const i = whatsappSettingsSchema.parse(raw);
  const alertPhone = i.alertPhone ? normalizePeruPhone(i.alertPhone) : null;
  if (i.alertPhone && !alertPhone) throw new DomainError("VALIDATION", "El teléfono de alertas no es válido (ej. 987654321).");
  const db = platformDb();
  if (i.provider === "META_CLOUD") {
    if (!i.wabaId || !i.phoneNumberId) throw new DomainError("VALIDATION", "Ingrese el WABA ID y el Phone Number ID de Meta.");
    const hasToken = i.token || (await db.tenantSecret.count({ where: { tenant_id: ctx.tenantId, kind: "WHATSAPP_TOKEN", is_active: true } }));
    if (!hasToken) throw new DomainError("VALIDATION", "Ingrese el token de acceso de Meta.");
  }
  await db.$transaction(async (tx) => {
    if (i.token) await storeWhatsappToken(tx, ctx.tenantId, i.token, ctx.userId);
    const data = {
      provider: i.provider, waba_id: i.wabaId || null, phone_number_id: i.phoneNumberId || null,
      enabled: i.enabled, reminder_days: i.reminderDays, alert_phone: alertPhone,
    };
    await tx.whatsappSettings.upsert({ where: { tenant_id: ctx.tenantId }, create: { tenant_id: ctx.tenantId, ...data }, update: data });
    await audit(tx, {
      tenantId: ctx.tenantId, actorUserId: ctx.userId, actorKind: "tenant_user", action: "whatsapp.settings",
      entityType: "tenant", entityId: ctx.tenantId,
      after: { ...data, token: i.token ? "[REDACTED]" : "sin cambios" },
    });
  });
}

/** Credenciales para enviar. null = el negocio no configuró WhatsApp propio (se usa la configuración global, si existe). */
export async function loadTenantWhatsapp(tenantId: string): Promise<TenantWhatsapp | null> {
  const row = await platformDb().whatsappSettings.findUnique({ where: { tenant_id: tenantId } });
  if (!row?.enabled) return null;
  if (row.provider === "WEB_QR") return { provider: "WEB_QR", tenantId };
  const token = await loadWhatsappToken(tenantId);
  return row.phone_number_id && token ? { provider: "META_CLOUD", phoneNumberId: row.phone_number_id, token } : null;
}

/** Verifica token + número contra Meta sin enviar mensajes. */
export async function testMetaConnection(ctx: TenantDbContext): Promise<{ phone: string; name: string }> {
  const row = await platformDb().whatsappSettings.findUnique({ where: { tenant_id: ctx.tenantId } });
  const token = await loadWhatsappToken(ctx.tenantId);
  if (!row?.phone_number_id || !token) throw new DomainError("NOT_CONFIGURED", "Guarde primero el token y el Phone Number ID.");
  const res = await fetch(`https://graph.facebook.com/v21.0/${row.phone_number_id}?fields=display_phone_number,verified_name`, {
    headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000),
  }).catch(() => null);
  if (!res) throw new DomainError("WA_UNREACHABLE", "No se pudo contactar a Meta. Intente nuevamente.");
  const body = (await res.json().catch(() => ({}))) as { display_phone_number?: string; verified_name?: string; error?: { message?: string } };
  if (!res.ok) throw new DomainError("WA_REJECTED", `Meta rechazó la conexión: ${body.error?.message?.slice(0, 200) ?? `HTTP ${res.status}`}`);
  return { phone: body.display_phone_number ?? "", name: body.verified_name ?? "" };
}
