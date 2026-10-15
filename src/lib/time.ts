const TZ = "America/Lima";

/** Fecha/hora actual en Lima (Perú no tiene horario de verano: UTC-5 fijo). */
export function limaNow(now: Date = new Date()): { date: string; time: string; dateObj: Date } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  ) as Record<string, string>;
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  return { date, time: `${parts.hour}:${parts.minute}:${parts.second}`, dateObj: new Date(`${date}T00:00:00.000Z`) };
}

/** Periodo de consumo YYYY-MM en hora de Lima. */
export const limaPeriod = (now: Date = new Date()): string => limaNow(now).date.slice(0, 7);

export const addDays = (d: Date, days: number): Date => new Date(d.getTime() + days * 86_400_000);
