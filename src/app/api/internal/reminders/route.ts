import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { bearer, safeEqual } from "@/lib/http";
import { scanReminders } from "@/lib/whatsapp/reminders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Tarea diaria de recordatorios (cron externo o pg_cron). ?dryRun=1 solo simula. La entrega la hace el worker del outbox. */
export async function POST(req: Request): Promise<Response> {
  const token = bearer(req);
  if (!token || !safeEqual(token, env().INTERNAL_CRON_SECRET)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const dryRun = new URL(req.url).searchParams.get("dryRun") === "1";
  const scan = await scanReminders({ dryRun });
  return NextResponse.json({ dryRun, tenants: scan.tenants, queued: scan.queued, found: scan.items.length });
}
