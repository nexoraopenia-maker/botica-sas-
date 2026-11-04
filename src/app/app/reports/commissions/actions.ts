"use server";

import { revalidatePath } from "next/cache";
import type { z } from "zod";
import { requireTenant } from "@/lib/auth/session";
import { ok, toActionError, type ActionResult } from "@/lib/result";
import { saveCommissionRate, type rateSchema } from "@/lib/reports/commissions";

export async function saveCommissionRateAction(i: z.input<typeof rateSchema>): Promise<ActionResult<null>> {
  try {
    const ctx = await requireTenant({ permission: "users.manage", mutation: true });
    await saveCommissionRate({ tenantId: ctx.tenantId, userId: ctx.userId }, i);
    revalidatePath("/app/reports/commissions");
    return ok(null);
  } catch (e) {
    return toActionError(e);
  }
}
