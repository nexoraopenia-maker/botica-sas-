"use server";

import { after } from "next/server";
import { z } from "zod";
import { withTenant } from "@/lib/db";
import { DomainError } from "@/lib/result";
import { resendDocumentNow, runOutboxEventNow } from "@/workers/outbox";
import { requireTenant } from "@/lib/auth/session";
import { issueCreditNote, type creditNoteSchema } from "@/lib/sunat/credit-note";
import { ok, toActionError, type ActionResult } from "@/lib/result";

export async function issueCreditNoteAction(
  input: z.input<typeof creditNoteSchema>,
): Promise<ActionResult<{ documentId: string; series: string; number: number }>> {
  try {
    const ctx = await requireTenant({ permission: "documents.credit_note", mutation: true });
    const note = await issueCreditNote({ tenantId: ctx.tenantId, userId: ctx.userId }, input);
    after(() => runOutboxEventNow(`document.issued:${note.documentId}`).catch((err) => console.error("[sunat] envío NC", err)));
    return ok(note);
  } catch (e) {
    return toActionError(e);
  }
}

/** Envía (o reenvía) a SUNAT un comprobante pendiente o con error reintentable, en este momento. */
export async function sendToSunatAction(documentId: string): Promise<ActionResult<{ status: string; code: string | null; description: string | null }>> {
  try {
    const id = z.uuid().parse(documentId);
    const ctx = await requireTenant({ permission: "documents.read", mutation: true });
    const db = { tenantId: ctx.tenantId, userId: ctx.userId };
    const doc = await withTenant(db, (tx) => tx.document.findFirst({ where: { id }, select: { id: true, status: true } }));
    if (!doc) throw new DomainError("NOT_FOUND", "Comprobante no encontrado.");
    if (!["PENDIENTE", "ERROR_REINTENTABLE", "ENVIANDO"].includes(doc.status)) {
      throw new DomainError("INVALID_STATE", "Este comprobante ya tiene respuesta de SUNAT.");
    }
    await resendDocumentNow(ctx.tenantId, id);
    const after_ = await withTenant(db, (tx) => tx.document.findFirstOrThrow({ where: { id }, select: { status: true, sunat_code: true, sunat_description: true } }));
    return ok({ status: after_.status, code: after_.sunat_code, description: after_.sunat_description });
  } catch (e) {
    return toActionError(e);
  }
}
