"use server";

import type { z } from "zod";
import { requireTenant } from "@/lib/auth/session";
import { issueCreditNote, type creditNoteSchema } from "@/lib/sunat/credit-note";
import { ok, toActionError, type ActionResult } from "@/lib/result";

export async function issueCreditNoteAction(
  input: z.input<typeof creditNoteSchema>,
): Promise<ActionResult<{ documentId: string; series: string; number: number }>> {
  try {
    const ctx = await requireTenant({ permission: "documents.credit_note", mutation: true });
    return ok(await issueCreditNote({ tenantId: ctx.tenantId, userId: ctx.userId }, input));
  } catch (e) {
    return toActionError(e);
  }
}
