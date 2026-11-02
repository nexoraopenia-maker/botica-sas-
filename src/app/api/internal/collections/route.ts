import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { bearer, safeEqual } from "@/lib/http";
import { scanCollections } from "@/lib/services/collections";
import { runOutboxBatch } from "@/workers/outbox";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function authorized(req: Request): boolean {
  const token = bearer(req);
  if (!token) return false;
  const e = env();
  return safeEqual(token, e.INTERNAL_CRON_SECRET) || (!!e.CRON_SECRET && safeEqual(token, e.CRON_SECRET));
}

async function run(req: Request): Promise<Response> {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const dryRun = new URL(req.url).searchParams.get("dryRun") === "1";
  const scan = await scanCollections({ dryRun });
  // Vercel Cron llama una vez al día: la entrega se dispara aquí y lo que falle queda en el outbox para reintento
  const delivery = !dryRun && scan.queued > 0 ? await runOutboxBatch({ types: ["notification.send"], limit: 20, deadlineMs: 40_000 }) : null;
  return NextResponse.json({ dryRun, tenants: scan.tenants, found: scan.items.length, queued: scan.queued, skippedNoConsent: scan.skippedNoConsent, delivery });
}

/** Tarea diaria de cobranza. GET: Vercel Cron (ver vercel.json). POST: cron externo. ?dryRun=1 solo simula. */
export const GET = run;
export const POST = run;
