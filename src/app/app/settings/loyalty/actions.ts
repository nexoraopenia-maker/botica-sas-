"use server";

import { revalidatePath } from "next/cache";
import type { z } from "zod";
import { requireTenant } from "@/lib/auth/session";
import { saveLoyaltySettings, type loyaltySchema } from "@/lib/loyalty/wallet";
import { ok, toActionError, type ActionResult } from "@/lib/result";

export async function saveLoyaltyAction(i: z.input<typeof loyaltySchema>): Promise<ActionResult<null>> {
  try {
    const ctx = await requireTenant({ permission: "settings.manage", mutation: true });
    await saveLoyaltySettings({ tenantId: ctx.tenantId, userId: ctx.userId }, i);
    revalidatePath("/app/settings/loyalty");
    revalidatePath("/app/pos");
    return ok(null);
  } catch (e) {
    return toActionError(e);
  }
}
