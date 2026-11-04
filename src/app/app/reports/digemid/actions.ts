"use server";

import { revalidatePath } from "next/cache";
import { requireTenant } from "@/lib/auth/session";
import { ok, toActionError, type ActionResult } from "@/lib/result";
import { saveEstablishmentCode, saveProductCode } from "@/lib/reports/digemid";

const guard = () => requireTenant({ permission: "pharmacy.controlled_log", module: "PHARMACY", mutation: true });

export async function saveEstablishmentCodeAction(branchId: string, code: string): Promise<ActionResult<null>> {
  try {
    const ctx = await guard();
    await saveEstablishmentCode({ tenantId: ctx.tenantId, userId: ctx.userId }, branchId, code);
    revalidatePath("/app/reports/digemid");
    return ok(null);
  } catch (e) {
    return toActionError(e);
  }
}

export async function saveProductCodeAction(productId: string, code: string): Promise<ActionResult<null>> {
  try {
    const ctx = await guard();
    await saveProductCode({ tenantId: ctx.tenantId, userId: ctx.userId }, productId, code);
    revalidatePath("/app/reports/digemid");
    return ok(null);
  } catch (e) {
    return toActionError(e);
  }
}
