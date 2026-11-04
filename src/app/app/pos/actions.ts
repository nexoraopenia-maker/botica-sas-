"use server";

import { after } from "next/server";
import { runOutboxEventNow } from "@/workers/outbox";
import { requireTenant } from "@/lib/auth/session";
import { hasPermission } from "@/lib/auth/permissions";
import { createSale, type CreateSaleInput, type SaleResult } from "@/lib/inventory/pos";
import { searchProducts, type SearchResult } from "@/lib/pharmacy/search";
import { closeCash, getCashSummary, type CashSummary, type closeCashSchema } from "@/lib/pos/cash-closure";
import type { ClosureResult } from "@/lib/pos/cash-closure-calc";
import type { z } from "zod";
import { walletBalance } from "@/lib/loyalty/wallet";
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

export async function cashSummaryAction(branchId: string): Promise<ActionResult<CashSummary>> {
  try {
    const ctx = await requireTenant({ permission: "pos.sell", branchId });
    return ok(await getCashSummary({ tenantId: ctx.tenantId, userId: ctx.userId }, branchId));
  } catch (e) {
    return toActionError(e);
  }
}

export async function closeCashAction(input: z.input<typeof closeCashSchema>): Promise<ActionResult<ClosureResult & { closureId: string; replayed: boolean }>> {
  try {
    const ctx = await requireTenant({ permission: "pos.sell", mutation: true, branchId: input.branchId });
    return ok(await closeCash({ tenantId: ctx.tenantId, userId: ctx.userId }, input));
  } catch (e) {
    return toActionError(e);
  }
}

/** Saldo del monedero del cliente identificado en caja. null = cliente aún no registrado. */
export async function walletBalanceAction(docType: "DNI" | "RUC", docNumber: string): Promise<ActionResult<{ balance: string | null }>> {
  try {
    const ctx = await requireTenant({ permission: "pos.sell" });
    const valid = docType === "DNI" ? /^\d{8}$/.test(docNumber) : /^\d{11}$/.test(docNumber);
    return ok({ balance: valid ? await walletBalance({ tenantId: ctx.tenantId, userId: ctx.userId }, docType, docNumber) : null });
  } catch (e) {
    return toActionError(e);
  }
}
