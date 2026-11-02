/** Fecha de hoy en Lima (AAAA-MM-DD) para valores por defecto de formularios. */
export const limaToday = (): string => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Lima" }).format(new Date());
