"use server";

import { after } from "next/server";
import { revalidatePath } from "next/cache";
import type { z } from "zod";
import { requireTenant } from "@/lib/auth/session";
import { ok, toActionError, type ActionResult } from "@/lib/result";
import { saveWhatsappSettings, testMetaConnection, type whatsappSettingsSchema } from "@/lib/whatsapp/settings";
import { getBridgeState, type BridgeState } from "@/lib/whatsapp/bridge";
import { scanReminders, type ReminderScan } from "@/lib/whatsapp/reminders";
import { runOutboxBatch } from "@/workers/outbox";

const guard = (mutation = true) => requireTenant({ permission: "settings.manage", mutation });
const db = (c: { tenantId: string; userId: string }) => ({ tenantId: c.tenantId, userId: c.userId });

export async function saveWhatsappAction(input: z.input<typeof whatsappSettingsSchema>): Promise<ActionResult<null>> {
  try {
    const ctx = await guard();
    await saveWhatsappSettings(db(ctx), input);
    revalidatePath("/app/settings/whatsapp");
    return ok(null);
  } catch (e) {
    return toActionError(e);
  }
}

export async function testWhatsappAction(): Promise<ActionResult<{ phone: string; name: string }>> {
  try {
    const ctx = await guard(false);
    return ok(await testMetaConnection(db(ctx)));
  } catch (e) {
    return toActionError(e);
  }
}

export async function bridgeStateAction(): Promise<ActionResult<BridgeState>> {
  try {
    const ctx = await guard(false);
    return ok(await getBridgeState(ctx.tenantId));
  } catch (e) {
    return toActionError(e);
  }
}

/** Cron simulado: dryRun muestra qué se enviaría; sin dryRun encola y dispara el envío. */
export async function runRemindersAction(dryRun: boolean): Promise<ActionResult<ReminderScan>> {
  try {
    const ctx = await guard(!dryRun);
    const scan = await scanReminders({ tenantId: ctx.tenantId, dryRun });
    if (!dryRun && scan.queued > 0) {
      after(async () => {
        try {
          await runOutboxBatch({ types: ["notification.send"], limit: 20, deadlineMs: 40_000 });
        } catch (err) {
          console.error("[whatsapp] envío inmediato falló; queda pendiente", err);
        }
      });
    }
    return ok(scan);
  } catch (e) {
    return toActionError(e);
  }
}
