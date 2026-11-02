"use server";

import { after } from "next/server";
import { requireTenant } from "@/lib/auth/session";
import { ok, toActionError, type ActionResult } from "@/lib/result";
import { scanCollections, type CollectionScan } from "@/lib/services/collections";
import { runOutboxBatch } from "@/workers/outbox";

/** Cron de cobranza bajo demanda: dryRun muestra qué se enviaría; sin dryRun encola y dispara el envío. */
export async function runCollectionRemindersAction(dryRun: boolean): Promise<ActionResult<CollectionScan>> {
  try {
    const ctx = await requireTenant({ permission: "receivables.manage", module: "WORKSHOP", mutation: !dryRun });
    const scan = await scanCollections({ tenantId: ctx.tenantId, dryRun });
    if (!dryRun && scan.queued > 0) {
      after(async () => {
        try {
          await runOutboxBatch({ types: ["notification.send"], limit: 20, deadlineMs: 40_000 });
        } catch (err) {
          console.error("[cobranza] envío inmediato falló; queda pendiente", err);
        }
      });
    }
    return ok(scan);
  } catch (e) {
    return toActionError(e);
  }
}
