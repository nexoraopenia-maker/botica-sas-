import "server-only";
import { z } from "zod";
import { withTenant, type TenantDbContext } from "@/lib/db";
import { audit } from "@/lib/audit";
import { DomainError } from "@/lib/result";
import { normalizePeruPhone } from "@/lib/notifications/providers";

const opt = (max: number) => z.string().trim().max(max).optional().transform((v) => (v ? v : undefined));
const optNum = (min: number, max: number) => z.number().min(min).max(max).optional();

export const createRecordSchema = z.object({
  branchId: z.uuid(),
  petId: z.uuid().optional(),
  newPatient: z.object({
    ownerName: z.string().trim().min(3, "Nombre del propietario").max(160),
    ownerDni: z.string().trim().regex(/^\d{8}$/, "DNI: 8 dígitos").optional().or(z.literal("").transform(() => undefined)),
    ownerWhatsapp: opt(20),
    petName: z.string().trim().min(1, "Nombre del paciente").max(80),
    species: z.enum(["CANINE", "FELINE", "BOVINE", "OVINE", "CAPRINE", "PORCINE", "EQUINE", "AVIAN", "CAVY", "RABBIT", "OTHER"]),
    breed: opt(80),
    sex: z.enum(["MALE", "FEMALE", "UNKNOWN"]).default("UNKNOWN"),
  }).optional(),
  visitType: z.enum(["CONSULTATION", "VACCINATION", "DEWORMING", "HOSPITALIZATION", "SURGERY", "GROOMING", "CONTROL"]),
  reason: z.string().trim().min(3, "Indique el motivo de la consulta").max(500),
  anamnesis: opt(2000),
  weightKg: optNum(0, 5000),
  temperatureC: optNum(20, 50),
  diagnosis: opt(2000),
  treatment: opt(2000),
  nextControlAt: z.iso.date().optional(),
});

/** Abre la historia clínica: de un paciente existente o registrándolo junto con su propietario. */
export async function createMedicalRecord(ctx: TenantDbContext, raw: z.input<typeof createRecordSchema>): Promise<{ petId: string; recordId: string }> {
  const i = createRecordSchema.parse(raw);
  if (!i.petId && !i.newPatient) throw new DomainError("VALIDATION", "Seleccione un paciente o registre uno nuevo.");
  let whatsapp: string | null = null;
  if (i.newPatient?.ownerWhatsapp) {
    whatsapp = normalizePeruPhone(i.newPatient.ownerWhatsapp);
    if (!whatsapp) throw new DomainError("VALIDATION", "El WhatsApp del propietario no es válido (ej. 987654321).");
  }
  return withTenant(ctx, async (tx) => {
    let petId = i.petId;
    if (petId) {
      const pet = await tx.pet.findFirst({ where: { id: petId, deleted_at: null }, select: { id: true } });
      if (!pet) throw new DomainError("NOT_FOUND", "El paciente no existe.");
    } else {
      const n = i.newPatient!;
      const owner = await tx.owner.create({
        data: { tenant_id: ctx.tenantId, full_name: n.ownerName, doc_type: n.ownerDni ? "DNI" : null, doc_number: n.ownerDni ?? null, whatsapp },
      });
      const pet = await tx.pet.create({
        data: { tenant_id: ctx.tenantId, owner_id: owner.id, name: n.petName, species: n.species, breed: n.breed ?? null, sex: n.sex, weight_kg: i.weightKg ?? null },
      });
      petId = pet.id;
    }
    const record = await tx.medicalRecord.create({
      data: {
        tenant_id: ctx.tenantId, branch_id: i.branchId, pet_id: petId, vet_user_id: ctx.userId, visit_type: i.visitType,
        reason: i.reason, anamnesis: i.anamnesis ?? null, weight_kg: i.weightKg ?? null, temperature_c: i.temperatureC ?? null,
        diagnosis: i.diagnosis ?? null, treatment: i.treatment ?? null,
        next_control_at: i.nextControlAt ? new Date(`${i.nextControlAt}T00:00:00Z`) : null,
      },
    });
    await audit(tx, {
      tenantId: ctx.tenantId, actorUserId: ctx.userId, actorKind: "tenant_user", action: "medical_record.create",
      entityType: "medical_record", entityId: record.id, after: { pet: petId, visit: i.visitType },
    });
    return { petId, recordId: record.id };
  });
}
