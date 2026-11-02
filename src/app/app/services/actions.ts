"use server";

import { revalidatePath } from "next/cache";
import type { z } from "zod";
import { requireTenant } from "@/lib/auth/session";
import { hasPermission } from "@/lib/auth/permissions";
import { DomainError, ok, toActionError, type ActionResult } from "@/lib/result";
import {
  addEvidence, changeOrderStatus, createOrder, registerPayment, updateOrderTerms,
  type changeStatusSchema, type CreatedOrder, type createOrderSchema, type paymentSchema, type updateTermsSchema,
} from "@/lib/services/orders";

const db = (c: { tenantId: string; userId: string }) => ({ tenantId: c.tenantId, userId: c.userId });
const refresh = () => { revalidatePath("/app/services", "layout"); revalidatePath("/app/receivables"); };

export async function createOrderAction(i: z.input<typeof createOrderSchema>): Promise<ActionResult<CreatedOrder>> {
  try {
    const ctx = await requireTenant({ permission: "services.manage", module: "WORKSHOP", mutation: true, branchId: i.branchId });
    const data = await createOrder(db(ctx), i);
    refresh();
    return ok(data);
  } catch (e) {
    return toActionError(e);
  }
}

export async function changeStatusAction(i: z.input<typeof changeStatusSchema>): Promise<ActionResult<null>> {
  try {
    const ctx = await requireTenant({ permission: "services.manage", module: "WORKSHOP", mutation: true });
    await changeOrderStatus(db(ctx), i);
    refresh();
    return ok(null);
  } catch (e) {
    return toActionError(e);
  }
}

export async function updateTermsAction(i: z.input<typeof updateTermsSchema>): Promise<ActionResult<null>> {
  try {
    const ctx = await requireTenant({ permission: "services.manage", module: "WORKSHOP", mutation: true });
    await updateOrderTerms(db(ctx), i);
    refresh();
    return ok(null);
  } catch (e) {
    return toActionError(e);
  }
}

export async function addEvidenceAction(form: FormData): Promise<ActionResult<{ count: number }>> {
  try {
    const ctx = await requireTenant({ permission: "services.manage", module: "WORKSHOP", mutation: true });
    const data = await addEvidence(db(ctx), String(form.get("orderId") ?? ""), form.get("file") as File);
    refresh();
    return ok(data);
  } catch (e) {
    return toActionError(e);
  }
}

/** Cobro: las órdenes al contado las cobra recepción; los créditos, quien tenga receivables.manage. */
export async function registerPaymentAction(i: z.input<typeof paymentSchema>): Promise<ActionResult<{ balanceDue: string; replayed: boolean }>> {
  try {
    const ctx = await requireTenant({ module: "WORKSHOP", mutation: true });
    const canCollectCredit = hasPermission(ctx.permissions, "receivables.manage");
    if (!canCollectCredit && !hasPermission(ctx.permissions, "services.manage")) throw new DomainError("FORBIDDEN", "No tiene permiso para registrar cobros.");
    const data = await registerPayment(db(ctx), i, { canCollectCredit });
    refresh();
    return ok(data);
  } catch (e) {
    return toActionError(e);
  }
}
