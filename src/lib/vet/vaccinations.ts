import "server-only";
import { z } from "zod";
import { withTenant, type TenantDbContext } from "@/lib/db";
import { DomainError } from "@/lib/result";
import { limaNow } from "@/lib/time";
import { computeSchedule } from "@/lib/vet/vaccine-schedule";

export const applyVaccinationSchema = z.object({
  petId: z.uuid(),
  vaccineId: z.uuid(),
  branchId: z.uuid(),
  appliedAt: z.iso.date().optional(),
  /** Si se indica, se descuenta 1 unidad del producto (lote preferido o FEFO) */
  consumeStock: z.boolean().default(true),
  preferredBatchId: z.uuid().optional(),
  medicalRecordId: z.uuid().optional(),
  notes: z.string().max(1000).optional(),
});

export interface ApplyVaccinationResult {
  vaccinationId: string;
  doseNumber: number;
  nextDueAt: string | null;
  lotCode: string | null;
  warnings: string[];
}

/** Registra la aplicación, calcula la próxima dosis y descuenta el biológico usado (kardex CLINICAL_USE). */
export async function applyVaccination(ctx: TenantDbContext, raw: z.input<typeof applyVaccinationSchema>): Promise<ApplyVaccinationResult> {
  const input = applyVaccinationSchema.parse(raw);
  const appliedAt = input.appliedAt ? new Date(`${input.appliedAt}T00:00:00Z`) : limaNow().dateObj;
  if (appliedAt > limaNow().dateObj) throw new DomainError("FUTURE_DATE", "La fecha de aplicación no puede ser futura.");

  return withTenant(ctx, async (tx) => {
    const [pet, vaccine] = await Promise.all([
      tx.pet.findFirst({ where: { id: input.petId, deleted_at: null } }),
      tx.vaccineCatalog.findFirst({ where: { id: input.vaccineId, is_active: true, deleted_at: null } }),
    ]);
    if (!pet) throw new DomainError("NOT_FOUND", "Mascota no encontrada.");
    if (pet.deceased_at) throw new DomainError("PET_DECEASED", "La mascota está registrada como fallecida.");
    if (!vaccine) throw new DomainError("NOT_FOUND", "Vacuna no encontrada.");
    if (vaccine.species !== pet.species) {
      throw new DomainError("SPECIES_MISMATCH", `${vaccine.name} no corresponde a la especie de ${pet.name}.`);
    }

    const history = await tx.petVaccination.findMany({
      where: { pet_id: pet.id, vaccine_id: vaccine.id, deleted_at: null },
      select: { applied_at: true },
    });
    const schedule = computeSchedule({
      protocol: vaccine,
      birthDate: pet.birth_date,
      previousApplications: history.map((h) => h.applied_at),
      appliedAt,
    });

    const vaccinationId = crypto.randomUUID();
    let batchId: string | null = null;
    let lotCode: string | null = null;
    if (input.consumeStock && vaccine.product_id) {
      const rows = await tx.$queryRaw<{ batch_id: string }[]>`
        SELECT batch_id FROM app.consume_stock_fefo(
          ${ctx.tenantId}::uuid, ${input.branchId}::uuid, ${vaccine.product_id}::uuid, 1::numeric,
          'CLINICAL_USE'::"StockMovementType", 'pet_vaccination', ${vaccinationId}::uuid, ${ctx.userId}::uuid,
          ${input.preferredBatchId ?? null}::uuid)`;
      batchId = rows[0]?.batch_id ?? null;
      if (batchId) {
        lotCode = (await tx.productBatch.findUnique({ where: { id: batchId }, select: { lot_code: true } }))?.lot_code ?? null;
      }
    }

    await tx.petVaccination.create({
      data: {
        id: vaccinationId,
        tenant_id: ctx.tenantId,
        pet_id: pet.id,
        vaccine_id: vaccine.id,
        dose_number: schedule.doseNumber,
        is_booster: schedule.isBooster,
        applied_at: appliedAt,
        next_due_at: schedule.nextDueAt,
        batch_id: batchId,
        lot_code: lotCode,
        applied_by: ctx.userId,
        medical_record_id: input.medicalRecordId ?? null,
        notes: input.notes ?? null,
      },
    });

    return {
      vaccinationId,
      doseNumber: schedule.doseNumber,
      nextDueAt: schedule.nextDueAt?.toISOString().slice(0, 10) ?? null,
      lotCode,
      warnings: schedule.warnings,
    };
  });
}

export interface DueVaccineRow {
  pet_id: string;
  pet_name: string;
  species: string;
  owner_name: string;
  owner_whatsapp: string | null;
  vaccine_name: string;
  dose_number: number;
  next_due_at: Date;
  days_left: number;
}

/** Dashboard: vacunas vencidas o por vencer (solo la última aplicación de cada vacuna por mascota). */
export async function listDueVaccines(ctx: TenantDbContext, withinDays = 30): Promise<DueVaccineRow[]> {
  return withTenant(ctx, (tx) => tx.$queryRaw<DueVaccineRow[]>`
    WITH latest AS (
      SELECT DISTINCT ON (pv.pet_id, pv.vaccine_id) pv.*
        FROM pet_vaccinations pv
       WHERE pv.deleted_at IS NULL
       ORDER BY pv.pet_id, pv.vaccine_id, pv.applied_at DESC, pv.created_at DESC
    )
    SELECT p.id AS pet_id, p.name AS pet_name, p.species::text AS species, o.full_name AS owner_name,
           o.whatsapp AS owner_whatsapp, vc.name AS vaccine_name, l.dose_number, l.next_due_at,
           (l.next_due_at - app.lima_today())::int AS days_left
      FROM latest l
      JOIN pets p ON p.id = l.pet_id AND p.deleted_at IS NULL AND p.deceased_at IS NULL
      JOIN owners o ON o.id = p.owner_id
      JOIN vaccine_catalog vc ON vc.id = l.vaccine_id
     WHERE l.next_due_at IS NOT NULL
       AND l.next_due_at <= app.lima_today() + ${withinDays}::int
     ORDER BY l.next_due_at ASC
     LIMIT 500`);
}
