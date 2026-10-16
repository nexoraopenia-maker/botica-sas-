"use server";

import { revalidatePath } from "next/cache";
import type { z } from "zod";
import { requireTenant } from "@/lib/auth/session";
import { hasPermission } from "@/lib/auth/permissions";
import { createProduct, type CreateProductResult, type createProductSchema } from "@/lib/inventory/products";
import { ok, toActionError, type ActionResult } from "@/lib/result";

export async function createProductAction(input: z.input<typeof createProductSchema>): Promise<ActionResult<CreateProductResult>> {
  try {
    const ctx = await requireTenant({ permission: "products.manage", mutation: true, ...(input.initialStock ? { branchId: input.initialStock.branchId } : {}) });
    const res = await createProduct({ tenantId: ctx.tenantId, userId: ctx.userId }, input, {
      canAdjustStock: hasPermission(ctx.permissions, "inventory.adjust"),
      modules: ctx.modules,
    });
    revalidatePath("/app", "layout");
    return ok(res);
  } catch (e) {
    return toActionError(e);
  }
}
