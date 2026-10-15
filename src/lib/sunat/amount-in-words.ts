import type { Decimal } from "@/lib/money";
import { round2 } from "@/lib/money";

const UNITS = ["", "UNO", "DOS", "TRES", "CUATRO", "CINCO", "SEIS", "SIETE", "OCHO", "NUEVE"];
const TEENS = ["DIEZ", "ONCE", "DOCE", "TRECE", "CATORCE", "QUINCE", "DIECISEIS", "DIECISIETE", "DIECIOCHO", "DIECINUEVE"];
const TWENTIES = ["VEINTE", "VEINTIUNO", "VEINTIDOS", "VEINTITRES", "VEINTICUATRO", "VEINTICINCO", "VEINTISEIS", "VEINTISIETE", "VEINTIOCHO", "VEINTINUEVE"];
const TENS = ["", "", "", "TREINTA", "CUARENTA", "CINCUENTA", "SESENTA", "SETENTA", "OCHENTA", "NOVENTA"];
const HUNDREDS = ["", "CIENTO", "DOSCIENTOS", "TRESCIENTOS", "CUATROCIENTOS", "QUINIENTOS", "SEISCIENTOS", "SETECIENTOS", "OCHOCIENTOS", "NOVECIENTOS"];

function below100(n: number): string {
  if (n < 10) return UNITS[n] ?? "";
  if (n < 20) return TEENS[n - 10] ?? "";
  if (n < 30) return TWENTIES[n - 20] ?? "";
  const t = Math.floor(n / 10);
  const u = n % 10;
  return `${TENS[t]}${u ? ` Y ${UNITS[u]}` : ""}`;
}

function below1000(n: number): string {
  if (n === 100) return "CIEN";
  const h = Math.floor(n / 100);
  const rest = n % 100;
  return [HUNDREDS[h], rest ? below100(rest) : ""].filter(Boolean).join(" ");
}

/** "UNO" → "UN" delante de MIL/MILLONES */
const apocope = (s: string): string => s.replace(/UNO$/, "UN").replace(/VEINTIUNO$/, "VEINTIUN");

export function integerToWords(n: number): string {
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError("Entero no soportado");
  if (n === 0) return "CERO";
  const millions = Math.floor(n / 1_000_000);
  const thousands = Math.floor((n % 1_000_000) / 1000);
  const rest = n % 1000;
  const parts: string[] = [];
  if (millions) parts.push(millions === 1 ? "UN MILLON" : `${apocope(integerToWords(millions))} MILLONES`);
  if (thousands) parts.push(thousands === 1 ? "MIL" : `${apocope(below1000(thousands))} MIL`);
  if (rest) parts.push(below1000(rest));
  return parts.join(" ");
}

const CURRENCY_NAME: Record<string, string> = { PEN: "SOLES", USD: "DÓLARES AMERICANOS" };

/** Leyenda 1000: "SON CIENTO DIECIOCHO CON 50/100 SOLES" */
export function amountInWords(amount: Decimal, currency = "PEN"): string {
  const v = round2(amount);
  const integer = v.floor().toNumber();
  const cents = v.minus(v.floor()).times(100).toDecimalPlaces(0).toNumber();
  return `SON ${integerToWords(integer)} CON ${String(cents).padStart(2, "0")}/100 ${CURRENCY_NAME[currency] ?? currency}`;
}
