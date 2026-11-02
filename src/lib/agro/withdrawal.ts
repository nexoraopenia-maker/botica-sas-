/** Fecha desde la cual el animal tratado puede destinarse a consumo humano. Día 0 = última aplicación. */
export function withdrawalEnd(lastApplication: string, days: number): string {
  const d = new Date(`${lastApplication}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function withdrawalStatus(lastApplication: string, days: number, today: string): { safeFrom: string; daysLeft: number; safe: boolean } {
  const safeFrom = withdrawalEnd(lastApplication, days);
  const daysLeft = Math.round((Date.parse(`${safeFrom}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
  return { safeFrom, daysLeft: Math.max(daysLeft, 0), safe: daysLeft <= 0 };
}
