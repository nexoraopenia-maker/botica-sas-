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
