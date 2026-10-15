"use server";

import { requireTenant } from "@/lib/auth/session";
import { hasPermission } from "@/lib/auth/permissions";
import { createSale, type CreateSaleInput, type SaleResult } from "@/lib/inventory/pos";
import { searchProducts, type SearchResult } from "@/lib/pharmacy/search";
import { ok, toActionError, type ActionResult } from "@/lib/result";

export async function createSaleAction(input: CreateSaleInput): Promise<ActionResult<SaleResult>> {
  try {
    const ctx = await requireTenant({ permission: "pos.sell", mutation: true, branchId: input.branchId });
    return ok(
      await createSale({ tenantId: ctx.tenantId, userId: ctx.userId }, input, {
        canOverridePrice: hasPermission(ctx.permissions, "pos.discount"),
        canDispenseRx: hasPermission(ctx.permissions, "pharmacy.dispense_rx"),
        pharmacyEnabled: ctx.modules.has("PHARMACY"),
      }),
    );
  } catch (e) {
    return toActionError(e);
  }
}

export async function searchProductsAction(branchId: string, q: string): Promise<ActionResult<SearchResult>> {
  try {
    const ctx = await requireTenant({ permission: "pos.sell", branchId });
    return ok(await searchProducts({ tenantId: ctx.tenantId, userId: ctx.userId }, branchId, q));
  } catch (e) {
    return toActionError(e);
  }
}
