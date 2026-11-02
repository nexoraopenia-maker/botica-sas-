import "server-only";
import QRCode from "qrcode";
import { env } from "@/lib/env";

export type BridgeState =
  | { status: "unavailable" }
  | { status: "offline" }
  | { status: "connected" }
  | { status: "qr"; svg: string };

export const bridgeConfigured = (): boolean => !!(env().WHATSAPP_QR_BRIDGE_URL && env().WHATSAPP_QR_BRIDGE_TOKEN);

/**
 * "Web QR Local" necesita un proceso con sesión persistente de WhatsApp Web: no puede correr en
 * funciones serverless. La app solo habla con un puente externo (URL fija de plataforma, nunca
 * elegida por el negocio: evita SSRF) y muestra el QR real que este entrega; sin puente no hay QR.
 */
export async function getBridgeState(tenantId: string): Promise<BridgeState> {
  const e = env();
  if (!e.WHATSAPP_QR_BRIDGE_URL || !e.WHATSAPP_QR_BRIDGE_TOKEN) return { status: "unavailable" };
  const res = await fetch(`${e.WHATSAPP_QR_BRIDGE_URL.replace(/\/$/, "")}/sessions/${tenantId}/qr`, {
    headers: { Authorization: `Bearer ${e.WHATSAPP_QR_BRIDGE_TOKEN}` }, cache: "no-store", signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  if (!res?.ok) return { status: "offline" };
  const body = (await res.json().catch(() => ({}))) as { status?: string; qr?: string };
  if (body.status === "connected") return { status: "connected" };
  if (body.status === "qr" && body.qr) return { status: "qr", svg: await QRCode.toString(body.qr, { type: "svg", margin: 1 }) };
  return { status: "offline" };
}
