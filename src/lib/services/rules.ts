/** Reglas puras de órdenes de servicio. Sin dependencias de servidor: también las usan componentes cliente. */
export const ORDER_STATUSES = ["RECEIVED", "IN_PROGRESS", "READY", "DELIVERED"] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const STATUS_LABEL: Record<OrderStatus, string> = { RECEIVED: "Recibido", IN_PROGRESS: "En proceso", READY: "Listo", DELIVERED: "Entregado" };
export const STATUS_TONE: Record<OrderStatus, string> = { RECEIVED: "gray", IN_PROGRESS: "blue", READY: "amber", DELIVERED: "green" };

export const MAX_EVIDENCE = 8;
export const MAX_EVIDENCE_BYTES = 4_000_000; // Vercel limita cada petición a 4,5 MB

export const orderCode = (n: number): string => `OS-${String(n).padStart(6, "0")}`;

/** Avanza de a un paso; se puede retroceder uno mientras no se haya entregado. Entregado es definitivo. */
export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  if (from === "DELIVERED") return false;
  return Math.abs(ORDER_STATUSES.indexOf(to) - ORDER_STATUSES.indexOf(from)) === 1;
}

/** Motivo por el que no se puede entregar, o null si procede. Al contado se entrega solo con el saldo pagado. */
export function deliveryBlocker(o: { paymentType: "CASH" | "CREDIT"; total: number; balanceDue: number; dueDate: string | null }): string | null {
  if (o.paymentType === "CASH" && o.balanceDue > 0) return `Saldo pendiente de S/ ${o.balanceDue.toFixed(2)}: registre el cobro antes de entregar, o cambie la orden a crédito.`;
  if (o.paymentType === "CREDIT" && o.total <= 0) return "Indique el monto de la orden antes de entregarla a crédito.";
  if (o.paymentType === "CREDIT" && !o.dueDate) return "Indique la fecha de vencimiento del crédito.";
  return null;
}

export type TrafficLight = "overdue" | "soon" | "ok";

export const daysBetween = (fromIso: string, toIso: string): number =>
  Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86_400_000);

/** Semáforo de vencimientos: rojo vencido, ámbar dentro de `soonDays` (incluye hoy), verde al día. */
export function trafficLight(dueDate: string, today: string, soonDays: number): { light: TrafficLight; days: number; label: string } {
  const days = daysBetween(today, dueDate);
  if (days < 0) return { light: "overdue", days, label: `Vencida hace ${-days} d` };
  if (days === 0) return { light: "soon", days, label: "Vence hoy" };
  if (days <= soonDays) return { light: "soon", days, label: `Vence en ${days} d` };
  return { light: "ok", days, label: `Al día · ${days} d` };
}

/** Tipo real del archivo por sus primeros bytes: el nombre y el tipo que envía el navegador no son confiables. */
export function detectImage(b: Uint8Array): { ext: "jpg" | "png" | "webp"; contentType: string } | null {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { ext: "jpg", contentType: "image/jpeg" };
  if (b.length > 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((v, i) => b[i] === v)) return { ext: "png", contentType: "image/png" };
  const ascii = (from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
  if (b.length > 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return { ext: "webp", contentType: "image/webp" };
  return null;
}
