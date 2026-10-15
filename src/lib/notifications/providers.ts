import "server-only";
import { env } from "@/lib/env";

export interface SendResult {
  ok: boolean;
  providerMessageId?: string;
  retryable: boolean;
  error?: string;
}

const GRAPH_VERSION = "v21.0";

/** E.164 Perú: 9 dígitos móviles → +51XXXXXXXXX */
export function normalizePeruPhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  if (/^9\d{8}$/.test(digits)) return `+51${digits}`;
  if (/^519\d{8}$/.test(digits)) return `+${digits}`;
  if (/^\d{10,15}$/.test(digits) && raw.trim().startsWith("+")) return `+${digits}`;
  return null;
}

async function asResult(res: Response, pickId: (j: unknown) => string | undefined): Promise<SendResult> {
  const body: unknown = await res.json().catch(() => ({}));
  if (res.ok) return { ok: true, providerMessageId: pickId(body), retryable: false };
  return { ok: false, retryable: res.status === 429 || res.status >= 500, error: `HTTP ${res.status}: ${JSON.stringify(body).slice(0, 500)}` };
}

export async function sendWhatsAppTemplate(to: string, template: string, params: string[], fallbackText: string): Promise<SendResult> {
  const e = env();
  const phone = normalizePeruPhone(to);
  if (!phone) return { ok: false, retryable: false, error: `Número inválido: ${to}` };

  if (e.WHATSAPP_PROVIDER === "meta") {
    if (!e.META_WA_PHONE_NUMBER_ID || !e.META_WA_ACCESS_TOKEN) return { ok: false, retryable: false, error: "WhatsApp (Meta) no configurado" };
    const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${e.META_WA_PHONE_NUMBER_ID}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${e.META_WA_ACCESS_TOKEN}` },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: phone.slice(1),
        type: "template",
        template: {
          name: template,
          language: { code: "es" },
          components: [{ type: "body", parameters: params.map((text) => ({ type: "text", text })) }],
        },
      }),
      signal: AbortSignal.timeout(15_000),
    });
    return asResult(res, (j) => (j as { messages?: { id: string }[] }).messages?.[0]?.id);
  }

  if (!e.TWILIO_ACCOUNT_SID || !e.TWILIO_AUTH_TOKEN || !e.TWILIO_WHATSAPP_FROM) {
    return { ok: false, retryable: false, error: "WhatsApp (Twilio) no configurado" };
  }
  const form = new URLSearchParams({ From: `whatsapp:${e.TWILIO_WHATSAPP_FROM}`, To: `whatsapp:${phone}`, Body: fallbackText });
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${e.TWILIO_ACCOUNT_SID}/Messages.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(`${e.TWILIO_ACCOUNT_SID}:${e.TWILIO_AUTH_TOKEN}`).toString("base64")}`,
    },
    body: form,
    signal: AbortSignal.timeout(15_000),
  });
  return asResult(res, (j) => (j as { sid?: string }).sid);
}

export async function sendEmail(to: string, subject: string, text: string): Promise<SendResult> {
  const e = env();
  if (!e.RESEND_API_KEY) return { ok: false, retryable: false, error: "Email no configurado" };
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${e.RESEND_API_KEY}` },
    body: JSON.stringify({ from: e.EMAIL_FROM, to: [to], subject, text }),
    signal: AbortSignal.timeout(15_000),
  });
  return asResult(res, (j) => (j as { id?: string }).id);
}
