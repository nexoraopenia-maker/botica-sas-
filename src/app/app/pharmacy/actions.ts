"use server";

import { z } from "zod";
import { withTenant } from "@/lib/db";
import { requireTenant } from "@/lib/auth/session";
import { DomainError, ok, toActionError, type ActionResult } from "@/lib/result";
import { audit } from "@/lib/audit";
import { revalidatePath } from "next/cache";

const prescriptionSchema = z.object({
  branchId: z.uuid(),
  kind: z.enum(["SIMPLE", "RETAINED", "SPECIAL"]),
  customerId: z.uuid().optional(),
  patientName: z.string().trim().min(3),
  patientDoc: z.string().trim().max(15).optional(),
  prescriberName: z.string().trim().min(3),
  prescriberCmp: z.string().trim().regex(/^\d{3,6}$/, "Número de colegiatura"),
  prescriberDoc: z.string().trim().regex(/^\d{8}$/, "DNI del prescriptor: 8 dígitos").optional(),
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
    if (i.kind === "SPECIAL" && !i.prescriberDoc) throw new DomainError("VALIDATION", "Los productos controlados exigen el DNI del médico.");
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
          prescriber_cmp: i.prescriberCmp, prescriber_doc: i.prescriberDoc ?? null, prescriber_profession: i.prescriberProfession,
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
    revalidatePath("/app/pharmacy/prescriptions");
    return ok({ prescriptionId: id });
  } catch (e) {
    return toActionError(e);
  }
}

const pharmacistSchema = z.object({
  branchId: z.uuid(),
  userId: z.uuid(),
  fullName: z.string().trim().min(3).max(160),
  cqfpNumber: z.string().trim().regex(/^\d{3,6}$/, "Número de colegiatura CQFP"),
  isTechnicalDirector: z.boolean().default(false),
});

/** Alta del químico farmacéutico de la sucursal: sin él nadie puede validar recetas. */
export async function registerPharmacistAction(input: z.input<typeof pharmacistSchema>): Promise<ActionResult<{ id: string }>> {
  try {
    const i = pharmacistSchema.parse(input);
    const ctx = await requireTenant({ permission: "settings.manage", module: "PHARMACY", mutation: true });
    const id = await withTenant({ tenantId: ctx.tenantId, userId: ctx.userId }, async (tx) => {
      const member = await tx.tenantUser.findFirst({ where: { user_id: i.userId, status: "ACTIVE", deleted_at: null } });
      if (!member) throw new DomainError("NOT_FOUND", "El usuario no pertenece a este negocio.");
      const existing = await tx.pharmacistStaff.findFirst({ where: { branch_id: i.branchId, user_id: i.userId, deleted_at: null, OR: [{ valid_to: null }, { valid_to: { gte: new Date() } }] } });
      if (existing) throw new DomainError("DUPLICATE", "Ese usuario ya está registrado como químico farmacéutico en la sucursal.");
      const row = await tx.pharmacistStaff.create({
        data: {
          tenant_id: ctx.tenantId, branch_id: i.branchId, user_id: i.userId, full_name: i.fullName, cqfp_number: i.cqfpNumber,
          is_technical_director: i.isTechnicalDirector, valid_from: new Date(),
        },
      });
      await audit(tx, {
        tenantId: ctx.tenantId, actorUserId: ctx.userId, actorKind: "tenant_user", action: "pharmacist.register",
        entityType: "pharmacist_staff", entityId: row.id, after: { user: i.userId, cqfp: i.cqfpNumber, branch: i.branchId },
      });
      return row.id;
    });
    revalidatePath("/app/pharmacy/prescriptions");
    return ok({ id });
  } catch (e) {
    return toActionError(e);
  }
}
