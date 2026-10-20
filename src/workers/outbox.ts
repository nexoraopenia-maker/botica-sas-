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

    const results = await Promise.all(events.map((ev) => runClaimed(ev)));
    processed += results.filter((r) => r === "done").length;
    failed += results.filter((r) => r !== "done").length;
  }
  return { processed, failed };
}

/** Ejecuta el handler de un evento ya reclamado y registra el resultado (reintento con backoff o cola muerta). */
async function runClaimed(ev: ClaimedEvent): Promise<HandlerResult["status"]> {
  const db = platformDb();
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
    await db.outboxEvent.update({
      where: { id: ev.id },
      data: { status: "DONE", processed_at: new Date(), locked_by: null, locked_until: null, last_error: null },
    });
    return "done";
  }
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
  return result.status;
}

/**
 * Procesa YA un evento concreto (por dedupe_key), sin esperar al worker: lo usa el POS para enviar
 * el comprobante a SUNAT apenas se cobra. Mismo reclamo atómico que el lote (lease): si otro proceso
 * ya lo tomó o está terminado, no hace nada. Si falla, queda programado para reintento.
 */
export async function runOutboxEventNow(dedupeKey: string): Promise<HandlerResult["status"] | "skipped"> {
  const [ev] = await platformDb().$queryRaw<ClaimedEvent[]>`
    UPDATE outbox_events
       SET status = 'PROCESSING', locked_by = ${WORKER_ID}, locked_until = now() + interval '180 seconds', attempts = attempts + 1
     WHERE id = (
       SELECT id FROM outbox_events
        WHERE dedupe_key = ${dedupeKey}
          AND (status IN ('PENDING', 'FAILED') OR (status = 'PROCESSING' AND locked_until < now()))
        FOR UPDATE SKIP LOCKED
     )
    RETURNING id, event_type, payload, attempts, max_attempts`;
  if (!ev) return "skipped";
  return runClaimed(ev);
}

/** Reprograma (o crea, si se descartó) el envío de un comprobante a SUNAT y lo ejecuta ahora. */
export async function resendDocumentNow(tenantId: string, documentId: string): Promise<HandlerResult["status"] | "skipped"> {
  const key = `document.issued:${documentId}`;
  await platformDb().outboxEvent.upsert({
    where: { dedupe_key: key },
    create: { tenant_id: tenantId, aggregate_type: "document", aggregate_id: documentId, event_type: "document.issued", payload: { documentId }, dedupe_key: key },
    update: { status: "PENDING", next_attempt_at: new Date(), attempts: 0, last_error: null, locked_by: null, locked_until: null },
  });
  return runOutboxEventNow(key);
}
