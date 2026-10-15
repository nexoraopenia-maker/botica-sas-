import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { bearer, safeEqual } from "@/lib/http";
import { runOutboxBatch } from "@/workers/outbox";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Disparado por pg_cron (app.kick_outbox_worker) cada minuto cuando hay eventos pendientes. */
export async function POST(req: Request): Promise<Response> {
  const token = bearer(req);
  if (!token || !safeEqual(token, env().INTERNAL_CRON_SECRET)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const result = await runOutboxBatch({ deadlineMs: 50_000 });
  return NextResponse.json(result);
}
