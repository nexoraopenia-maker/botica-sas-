/** Reglas puras de lotes. Sin dependencias de servidor: también las usa el POS en el navegador. */
export const POS_EXPIRY_WARN_DAYS = 30;

export const daysUntil = (today: string, date: string): number =>
  Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);

/** Aviso del POS para el lote que se venderá primero (FEFO). null = sin aviso. */
export function expiryWarning(nearestExpiry: string | null, today: string, warnDays = POS_EXPIRY_WARN_DAYS): { days: number; label: string } | null {
  if (!nearestExpiry) return null;
  const days = daysUntil(today, nearestExpiry);
  if (days > warnDays) return null;
  return { days, label: days <= 0 ? "Vence hoy" : `Vence en ${days} d` };
}

/** Motivo por el que una línea de compra no se puede ingresar, o null si está completa. */
export function lotProblem(item: { lotCode?: string | null | undefined; expiryDate?: string | null | undefined }, today: string): string | null {
  if (!item.lotCode?.trim()) return "falta el número de lote";
  if (!item.expiryDate) return "falta la fecha de vencimiento";
  if (item.expiryDate <= today) return `el lote ${item.lotCode.trim()} ya está vencido`;
  return null;
}

// ── Lotes en la caja ─────────────────────────────────────────────────────────

/** Lote con stock de un producto en la sucursal, tal como lo necesita la caja. */
export interface LotInfo {
  id: string;
  code: string;
  /** YYYY-MM-DD; null = sin vencimiento */
  expiry: string | null;
  /** Unidad base */
  stock: string;
  quarantined: boolean;
}

export type LotStatus = "expired" | "quarantined" | "critical" | "ok";

/** Un lote vence al terminar su fecha: el día del vencimiento todavía se vende (igual que app.consume_stock_fefo). */
export function lotStatus(lot: Pick<LotInfo, "expiry" | "quarantined">, today: string, warnDays = POS_EXPIRY_WARN_DAYS): LotStatus {
  if (lot.quarantined) return "quarantined";
  if (!lot.expiry) return "ok";
  const days = daysUntil(today, lot.expiry);
  return days < 0 ? "expired" : days <= warnDays ? "critical" : "ok";
}

export const isSellableLot = (lot: LotInfo, today: string): boolean => {
  const status = lotStatus(lot, today);
  return status !== "expired" && status !== "quarantined" && Number(lot.stock) > 0;
};

/** Orden FEFO: vence antes, primero; los que no vencen, al final. Estable: a igual fecha se respeta el orden recibido. */
const byExpiry = (a: LotInfo, b: LotInfo): number => (a.expiry ?? "9999-12-31").localeCompare(b.expiry ?? "9999-12-31");

/** Lote que se vende primero (FEFO): el vendible que vence antes. null = no hay lote vendible. */
export function suggestLot(lots: readonly LotInfo[], today: string): LotInfo | null {
  return [...lots].filter((l) => isSellableLot(l, today)).sort(byExpiry)[0] ?? null;
}

/** Lote vendible que vence antes que el elegido (para avisar que FEFO recomienda otro), o null. */
export function olderLotThan(chosen: LotInfo, lots: readonly LotInfo[], today: string): LotInfo | null {
  const older = [...lots].filter((l) => l.id !== chosen.id && isSellableLot(l, today) && byExpiry(l, chosen) < 0).sort(byExpiry);
  return older[0] ?? null;
}
