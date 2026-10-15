import { addDays } from "@/lib/time";

export interface VaccineProtocol {
  name: string;
  first_dose_min_age_days: number;
  primary_doses: number;
  primary_interval_days: number;
  booster_interval_days: number | null;
  max_age_days_for_primary: number | null;
  adult_primary_doses: number | null;
}

export interface ScheduleInput {
  protocol: VaccineProtocol;
  birthDate: Date | null;
  /** Aplicaciones previas de ESTA vacuna, cualquier orden */
  previousApplications: Date[];
  appliedAt: Date;
}

export interface ScheduleResult {
  doseNumber: number;
  isBooster: boolean;
  nextDueAt: Date | null;
  warnings: string[];
}

const ageDays = (birth: Date, at: Date): number => Math.floor((at.getTime() - birth.getTime()) / 86_400_000);

/** Si pasó más de 2× el intervalo de refuerzo, la serie primaria se reinicia. */
const RESTART_FACTOR = 2;

/**
 * Calcula número de dosis y fecha de la próxima aplicación según el esquema:
 *   cachorro → serie primaria (N dosis cada X días) → refuerzo periódico.
 *   adulto sin historial → serie reducida (adult_primary_doses) si está definida.
 */
export function computeSchedule(i: ScheduleInput): ScheduleResult {
  const p = i.protocol;
  const warnings: string[] = [];
  const history = i.previousApplications.filter((d) => d < i.appliedAt).sort((a, b) => a.getTime() - b.getTime());

  // Reinicio de serie por abandono prolongado
  const last = history.at(-1);
  let series = history;
  if (last && p.booster_interval_days && ageDaysBetween(last, i.appliedAt) > p.booster_interval_days * RESTART_FACTOR) {
    series = [];
    warnings.push(`Refuerzo de ${p.name} vencido hace demasiado tiempo: se reinicia la serie primaria.`);
  }

  const firstDoseAt = series[0] ?? i.appliedAt;
  const ageAtFirst = i.birthDate ? ageDays(i.birthDate, firstDoseAt) : null;
  const primaryDoses =
    ageAtFirst !== null && p.max_age_days_for_primary !== null && p.adult_primary_doses !== null && ageAtFirst > p.max_age_days_for_primary
      ? p.adult_primary_doses
      : p.primary_doses;

  if (i.birthDate && series.length === 0) {
    const age = ageDays(i.birthDate, i.appliedAt);
    if (age < p.first_dose_min_age_days) {
      warnings.push(`${p.name}: aplicada a los ${age} días; edad mínima recomendada ${p.first_dose_min_age_days} días.`);
    }
  }

  const doseNumber = series.length + 1;
  if (doseNumber < primaryDoses) {
    return { doseNumber, isBooster: false, nextDueAt: addDays(i.appliedAt, p.primary_interval_days), warnings };
  }
  return {
    doseNumber,
    isBooster: doseNumber > primaryDoses,
    nextDueAt: p.booster_interval_days ? addDays(i.appliedAt, p.booster_interval_days) : null,
    warnings,
  };
}

function ageDaysBetween(a: Date, b: Date): number {
  return Math.floor((b.getTime() - a.getTime()) / 86_400_000);
}

/** Primera dosis sugerida para una mascota sin historial de esa vacuna. */
export function suggestedFirstDose(protocol: VaccineProtocol, birthDate: Date): Date {
  return addDays(birthDate, protocol.first_dose_min_age_days);
}
