import "server-only";
import { hostname } from "node:os";
import { platformDb } from "@/lib/db";
import { emitDocument, type HandlerResult } from "@/lib/sunat/emit";
import { processIngestionJob } from "@/lib/ai/ingestion/process";
import { dispatchNotification } from "@/lib/notifications/dispatch";
import { runTenantExport } from "@/lib/platform/export";

type Handler = (payload: Record<string, unknown>, attempt: number) => Promise<HandlerResult>;

const str = (v: unknown, name: string): string => {
  if (typeof v !== "string") throw new Error(`payload.${name} requerido`);
  return v;
};

export const HANDLERS: Record<string, Handler> = {
  "document.issued": (p, a) => emitDocument(str(p.documentId, "documentId"), a),
  "ai.ingest": (p, a) => processIngestionJob(str(p.jobId, "jobId"), a),
  "notification.send": (p, a) => dispatchNotification(str(p.notificationId, "notificationId"), a),
  "tenant.export": (p) => runTenantExport(str(p.exportId, "exportId")),
};

interface ClaimedEvent {
  id: bigint;
  event_type: string;
  payload: unknown;
  attempts: number;
  max_attempts: number;
}

const WORKER_ID = `${hostname()}:${process.pid}`;

/**
 * Procesa un lote del outbox. Varias instancias pueden correr en paralelo:
 * app.claim_outbox usa FOR UPDATE SKIP LOCKED + lease, y cada handler es idempotente.
 */
export async function runOutboxBatch(opts: { limit?: number; types?: string[]; deadlineMs?: number } = {}): Promise<{ processed: number; failed: number }> {
  const db = platformDb();
  const deadline = Date.now() + (opts.deadlineMs ?? 50_000);
  let processed = 0;
  let failed = 0;

  while (Date.now() < deadline) {
    const events = await db.$queryRaw<ClaimedEvent[]>`
      SELECT id, event_type, payload, attempts, max_attempts
        FROM app.claim_outbox(${WORKER_ID}, ${opts.types ?? null}::text[], ${opts.limit ?? 10}::int, 180)`;
    if (events.length === 0) break;

    await Promise.all(
      events.map(async (ev) => {
        const handler = HANDLERS[ev.event_type];
        let result: HandlerResult;
        try {
          result = handler
            ? await handler((ev.payload ?? {}) as Record<string, unknown>, ev.attempts)
            : { status: "dead", error: `Sin handler para ${ev.event_type}` };
        } catch (err) {
          result = { status: "retry", delayMs: 60_000 * ev.attempts, error: err instanceof Error ? err.message : String(err) };
        }

        if (result.status === "done") {
          processed++;
          await db.outboxEvent.update({
            where: { id: ev.id },
            data: { status: "DONE", processed_at: new Date(), locked_by: null, locked_until: null, last_error: null },
          });
          return;
        }
        failed++;
        const exhausted = result.status === "dead" || ev.attempts >= ev.max_attempts;
        await db.outboxEvent.update({
          where: { id: ev.id },
          data: {
            status: exhausted ? "DEAD" : "FAILED",
            last_error: result.error.slice(0, 2000),
            next_attempt_at: new Date(Date.now() + (result.status === "retry" ? result.delayMs : 0)),
            locked_by: null,
            locked_until: null,
          },
        });
      }),
    );
  }
  return { processed, failed };
}
