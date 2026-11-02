"use server";

import type { z } from "zod";
import { requireTenant } from "@/lib/auth/session";
import { applyVaccination, type applyVaccinationSchema, type ApplyVaccinationResult } from "@/lib/vet/vaccinations";
import { createMedicalRecord, type createRecordSchema } from "@/lib/vet/records";
import { ok, toActionError, type ActionResult } from "@/lib/result";

export async function applyVaccinationAction(input: z.input<typeof applyVaccinationSchema>): Promise<ActionResult<ApplyVaccinationResult>> {
  try {
    const ctx = await requireTenant({ permission: "vet.vaccinate", module: "VETERINARY", mutation: true, branchId: input.branchId });
    return ok(await applyVaccination({ tenantId: ctx.tenantId, userId: ctx.userId }, input));
  } catch (e) {
    return toActionError(e);
  }
}

export async function createRecordAction(input: z.input<typeof createRecordSchema>): Promise<ActionResult<{ petId: string; recordId: string }>> {
  try {
    const ctx = await requireTenant({ permission: "vet.records", module: "VETERINARY", mutation: true, branchId: input.branchId });
    return ok(await createMedicalRecord({ tenantId: ctx.tenantId, userId: ctx.userId }, input));
  } catch (e) {
    return toActionError(e);
  }
}
