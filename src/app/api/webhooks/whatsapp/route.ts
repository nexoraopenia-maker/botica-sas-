import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { platformDb } from "@/lib/db";
import { hmacSha256Hex, safeEqual } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Verificación del webhook (Meta). */
export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const verify = env().META_WA_VERIFY_TOKEN;
  if (verify && url.searchParams.get("hub.mode") === "subscribe" && url.searchParams.get("hub.verify_token") === verify) {
    return new Response(url.searchParams.get("hub.challenge") ?? "", { status: 200 });
  }
  return new Response("forbidden", { status: 403 });
}

interface MetaStatus {
  id: string;
  status: "sent" | "delivered" | "read" | "failed";
  timestamp: string;
  errors?: { code: number; title: string }[];
}

/** Estados de entrega → notifications (registro de entrega). */
export async function POST(req: Request): Promise<Response> {
  const secret = env().META_WA_APP_SECRET;
  const raw = await req.text();
  const sig = req.headers.get("x-hub-signature-256")?.replace("sha256=", "") ?? "";
  if (!secret || !safeEqual(sig, hmacSha256Hex(secret, raw))) {
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }
  const body = JSON.parse(raw) as { entry?: { changes?: { value?: { statuses?: MetaStatus[] } }[] }[] };
  const statuses = body.entry?.flatMap((e) => e.changes?.flatMap((c) => c.value?.statuses ?? []) ?? []) ?? [];
  const db = platformDb();
  for (const s of statuses) {
    const at = new Date(Number(s.timestamp) * 1000);
    await db.notification.updateMany({
      where: { provider_message_id: s.id },
      data:
        s.status === "delivered" ? { status: "DELIVERED", delivered_at: at }
        : s.status === "read" ? { status: "READ", read_at: at }
        : s.status === "failed" ? { status: "FAILED", error: s.errors?.map((e) => `${e.code} ${e.title}`).join("; ") ?? "failed" }
        : { status: "SENT" },
    });
  }
  return NextResponse.json({ ok: true });
}
