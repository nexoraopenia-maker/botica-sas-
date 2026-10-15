"use server";

import { z } from "zod";
import { withTenant } from "@/lib/db";
import { requireTenant } from "@/lib/auth/session";
import { DomainError, ok, toActionError, type ActionResult } from "@/lib/result";
import { audit } from "@/lib/audit";

const prescriptionSchema = z.object({
  branchId: z.uuid(),
  kind: z.enum(["SIMPLE", "RETAINED", "SPECIAL"]),
  customerId: z.uuid().optional(),
  patientName: z.string().trim().min(3),
  patientDoc: z.string().trim().max(15).optional(),
  prescriberName: z.string().trim().min(3),
  prescriberCmp: z.string().trim().regex(/^\d{3,6}$/, "Número de colegiatura"),
  prescriberProfession: z.enum(["MEDICO", "VETERINARIO", "ODONTOLOGO", "OBSTETRA"]).default("MEDICO"),
  issuedAt: z.iso.date(),
  validUntil: z.iso.date().optional(),
  diagnosis: z.string().max(500).optional(),
  imagePath: z.string().optional(),
  retained: z.boolean().default(false),
});

/** Registro de receta validada por el QF (requisito previo a dispensar productos con receta). */
export async function registerPrescriptionAction(input: z.input<typeof prescriptionSchema>): Promise<ActionResult<{ prescriptionId: string }>> {
  try {
    const i = prescriptionSchema.parse(input);
    const ctx = await requireTenant({ permission: "pharmacy.dispense_rx", module: "PHARMACY", mutation: true, branchId: i.branchId });
    if (i.kind !== "SIMPLE" && !i.retained) throw new DomainError("RX_MUST_RETAIN", "Las recetas retenidas/especiales deben quedar en el establecimiento.");
    const id = await withTenant({ tenantId: ctx.tenantId, userId: ctx.userId }, async (tx) => {
      const qf = await tx.pharmacistStaff.findFirst({
        where: { branch_id: i.branchId, user_id: ctx.userId, deleted_at: null, OR: [{ valid_to: null }, { valid_to: { gte: new Date() } }] },
      });
      if (!qf) throw new DomainError("QF_REQUIRED", "Solo un químico farmacéutico registrado en la sucursal puede validar recetas.");
      const rx = await tx.prescription.create({
        data: {
          tenant_id: ctx.tenantId, branch_id: i.branchId, kind: i.kind, customer_id: i.customerId ?? null,
          patient_name: i.patientName, patient_doc: i.patientDoc ?? null, prescriber_name: i.prescriberName,
          prescriber_cmp: i.prescriberCmp, prescriber_profession: i.prescriberProfession,
          issued_at: new Date(`${i.issuedAt}T00:00:00Z`), valid_until: i.validUntil ? new Date(`${i.validUntil}T00:00:00Z`) : null,
          diagnosis: i.diagnosis ?? null, image_path: i.imagePath ?? null, retained: i.retained, validated_by: ctx.userId,
        },
      });
      await audit(tx, {
        tenantId: ctx.tenantId, actorUserId: ctx.userId, actorKind: "tenant_user", action: "prescription.register",
        entityType: "prescription", entityId: rx.id, after: { kind: i.kind, cmp: i.prescriberCmp, qf: qf.cqfp_number },
      });
      return rx.id;
    });
    return ok({ prescriptionId: id });
  } catch (e) {
    return toActionError(e);
  }
}
