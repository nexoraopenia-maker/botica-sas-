/**
 * Worker de larga duración (contenedor/VM). Alternativa al disparo por pg_cron → /api/internal/outbox.
 *   pnpm worker
 */
import { runOutboxBatch } from "@/workers/outbox";

let stopping = false;
process.on("SIGTERM", () => (stopping = true));
process.on("SIGINT", () => (stopping = true));

async function main(): Promise<void> {
  while (!stopping) {
    const { processed, failed } = await runOutboxBatch({ deadlineMs: 20_000 });
    if (processed + failed === 0) await new Promise((r) => setTimeout(r, 2_000));
  }
}

main().catch((err) => {
  console.error("[worker] fatal", err);
  process.exit(1);
});
