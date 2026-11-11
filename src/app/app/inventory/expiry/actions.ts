"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { withTenant } from "@/lib/db";
import { requireTenant } from "@/lib/auth/session";
import { registerWaste, type WasteResult, type wasteSchema } from "@/lib/inventory/waste";
import { DomainError, ok, toActionError, type ActionResult } from "@/lib/result";

export async function registerWasteAction(input: z.input<typeof wasteSchema>): Promise<ActionResult<WasteResult>> {
  try {
    const batchId = z.uuid().parse(input.batchId);
    const ctx = await requireTenant({ permission: "inventory.waste", mutation: true });
    const db = { tenantId: ctx.tenantId, userId: ctx.userId };
    const batch = await withTenant(db, (tx) => tx.productBatch.findFirst({ where: { id: batchId, deleted_at: null }, select: { branch_id: true } }));
    if (!batch) throw new DomainError("NOT_FOUND", "Lote no encontrado.");
    await requireTenant({ permission: "inventory.waste", mutation: true, branchId: batch.branch_id }); // un usuario de otra sucursal no da de baja este lote
    const res = await registerWaste({ ...db, permissions: ctx.permissions }, input);
    revalidatePath("/app/inventory/expiry");
    revalidatePath("/app/inventory");
    revalidatePath("/app/pos");
    return ok(res);
  } catch (e) {
    return toActionError(e);
  }
}
