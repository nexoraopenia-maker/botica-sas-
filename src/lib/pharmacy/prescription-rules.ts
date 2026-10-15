import type { PrescriptionKind, SaleCondition } from "@/generated/prisma/enums";
import { DomainError } from "@/lib/result";

/**
 * Reglas de dispensación por condición de venta (Ley 29459, DS 014-2011-SA,
 * DS 023-2001-SA para controlados). Las vigencias son parametrizables porque
 * deben validarse con el asesor regulatorio del cliente (ver docs/COMPLIANCE.md).
 */
export interface RxPolicy {
  /** Vigencia de receta especial (controlados), días desde emisión */
  specialValidityDays: number;
  /** Vigencia de receta común, días desde emisión */
  commonValidityDays: number;
}

export const DEFAULT_RX_POLICY: RxPolicy = { specialValidityDays: 3, commonValidityDays: 30 };

export interface RxProduct {
  name: string;
  sale_condition: SaleCondition | null;
  is_controlled: boolean;
}

export interface RxRecord {
  id: string;
  kind: PrescriptionKind;
  issued_at: Date;
  valid_until: Date | null;
  retained: boolean;
  dispensed_at: Date | null;
  deleted_at: Date | null;
}

export const requiresPrescription = (p: RxProduct): boolean =>
  p.is_controlled || p.sale_condition === "PRESCRIPTION" || p.sale_condition === "RETAINED_PRESCRIPTION";

export function assertPrescriptionValid(p: RxProduct, rx: RxRecord | undefined, today: Date, policy = DEFAULT_RX_POLICY): void {
  if (!requiresPrescription(p)) return;
  if (!rx || rx.deleted_at) {
    throw new DomainError("RX_REQUIRED", `${p.name} requiere receta médica registrada`);
  }
  if (p.is_controlled) {
    if (rx.kind !== "SPECIAL") throw new DomainError("RX_SPECIAL_REQUIRED", `${p.name} es controlado: requiere receta especial`);
    if (!rx.retained) throw new DomainError("RX_MUST_RETAIN", `La receta especial de ${p.name} debe retenerse`);
  } else if (p.sale_condition === "RETAINED_PRESCRIPTION") {
    if (!rx.retained) throw new DomainError("RX_MUST_RETAIN", `La receta de ${p.name} debe retenerse en el establecimiento`);
  }
  const days = Math.floor((today.getTime() - rx.issued_at.getTime()) / 86_400_000);
  const limit = p.is_controlled ? policy.specialValidityDays : policy.commonValidityDays;
  const expired = rx.valid_until ? rx.valid_until < today : days > limit;
  if (expired) throw new DomainError("RX_EXPIRED", `La receta para ${p.name} está vencida`);

  // Recetas retenidas/especiales no se reutilizan
  if ((rx.retained || rx.kind === "SPECIAL") && rx.dispensed_at) {
    throw new DomainError("RX_ALREADY_USED", `La receta ya fue dispensada el ${rx.dispensed_at.toISOString().slice(0, 10)}`);
  }
}
