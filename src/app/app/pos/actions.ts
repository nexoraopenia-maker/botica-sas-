"use server";

import { after } from "next/server";
import { runOutboxEventNow } from "@/workers/outbox";
import { requireTenant } from "@/lib/auth/session";
import { hasPermission } from "@/lib/auth/permissions";
import { createSale, type CreateSaleInput, type SaleResult } from "@/lib/inventory/pos";
import { searchProducts, type SearchResult } from "@/lib/pharmacy/search";
import { ok, toActionError, type ActionResult } from "@/lib/result";

export async function createSaleAction(input: CreateSaleInput): Promise<ActionResult<SaleResult>> {
  try {
    const ctx = await requireTenant({ permission: "pos.sell", mutation: true, branchId: input.branchId });
    const sale = await createSale({ tenantId: ctx.tenantId, userId: ctx.userId }, input, {
      canOverridePrice: hasPermission(ctx.permissions, "pos.discount"),
      canDispenseRx: hasPermission(ctx.permissions, "pharmacy.dispense_rx"),
      pharmacyEnabled: ctx.modules.has("PHARMACY"),
    });
    // Envío a SUNAT inmediato pero fuera del camino crítico: la caja recibe la respuesta ya y la firma,
    // envío y CDR ocurren justo después (after). Si falla, el evento queda programado para reintento.
    if (!sale.replayed) {
      after(async () => {
        try {
          await runOutboxEventNow(`document.issued:${sale.documentId}`);
        } catch (err) {
          console.error("[sunat] envío inmediato falló; queda pendiente", sale.documentId, err);
        }
      });
    }
    return ok(sale);
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
