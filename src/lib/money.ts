import { Prisma } from "@/generated/prisma/client";

export const Decimal = Prisma.Decimal;
export type Decimal = Prisma.Decimal;
export type DecimalInput = Prisma.Decimal | number | string;

export const D = (v: DecimalInput): Decimal => new Decimal(v);

/** Redondeo SUNAT: half-up a 2 decimales para importes. */
export const round2 = (v: Decimal): Decimal => v.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
export const round10 = (v: Decimal): Decimal => v.toDecimalPlaces(10, Decimal.ROUND_HALF_UP);

export const IGV_RATE = D("0.18");
export const ICBPER_RATE = D("0.50");

export const fmt2 = (v: Decimal): string => round2(v).toFixed(2);
export const sum = (values: Decimal[]): Decimal => values.reduce((a, b) => a.plus(b), D(0));
