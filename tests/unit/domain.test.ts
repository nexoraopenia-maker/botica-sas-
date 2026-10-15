import { describe, expect, it } from "vitest";
import { computeSchedule } from "@/lib/vet/vaccine-schedule";
import { resolveSaleUnit } from "@/lib/pharmacy/fractioning";
import { assertPrescriptionValid } from "@/lib/pharmacy/prescription-rules";
import { extractLotExpiry } from "@/lib/ai/ingestion/xml-ubl";
import { normalizePeruPhone } from "@/lib/notifications/providers";
import { D } from "@/lib/money";

const d = (s: string) => new Date(`${s}T00:00:00Z`);
const polivalente = {
  name: "Séxtuple canina", first_dose_min_age_days: 42, primary_doses: 3, primary_interval_days: 21,
  booster_interval_days: 365, max_age_days_for_primary: 120, adult_primary_doses: 2,
};

describe("esquema de vacunación", () => {
  it("cachorro: dosis 1 → próxima a 21 días", () => {
    const r = computeSchedule({ protocol: polivalente, birthDate: d("2026-08-01"), previousApplications: [], appliedAt: d("2026-09-15") });
    expect(r.doseNumber).toBe(1);
    expect(r.nextDueAt?.toISOString().slice(0, 10)).toBe("2026-10-06");
  });

  it("dosis 3 cierra serie primaria → refuerzo anual", () => {
    const r = computeSchedule({
      protocol: polivalente, birthDate: d("2026-01-01"),
      previousApplications: [d("2026-02-15"), d("2026-03-08")], appliedAt: d("2026-03-29"),
    });
    expect(r.doseNumber).toBe(3);
    expect(r.isBooster).toBe(false);
    expect(r.nextDueAt?.toISOString().slice(0, 10)).toBe("2027-03-29");
  });

  it("adulto sin historial usa serie reducida", () => {
    const r = computeSchedule({ protocol: polivalente, birthDate: d("2022-01-01"), previousApplications: [d("2026-01-01")], appliedAt: d("2026-01-22") });
    expect(r.doseNumber).toBe(2);
    expect(r.nextDueAt?.toISOString().slice(0, 10)).toBe("2027-01-22");
  });

  it("refuerzo abandonado > 2 años reinicia la serie", () => {
    const r = computeSchedule({ protocol: polivalente, birthDate: d("2020-01-01"), previousApplications: [d("2021-01-01")], appliedAt: d("2026-01-01") });
    expect(r.doseNumber).toBe(1);
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  it("advierte aplicación antes de la edad mínima", () => {
    const r = computeSchedule({ protocol: polivalente, birthDate: d("2026-09-01"), previousApplications: [], appliedAt: d("2026-09-20") });
    expect(r.warnings[0]).toMatch(/edad mínima/);
  });
});

describe("fraccionamiento", () => {
  const p = { name: "Amoxicilina 500mg x100", unit_code: "NIU", sale_price: D("0.80"), package_price: D("65.00"), units_per_package: 100, package_unit_code: "BX", allow_fractional: false };
  it("caja → 100 unidades base al precio de caja", () => {
    const r = resolveSaleUnit(p, "PACKAGE", 2);
    expect(r.baseQuantity.toString()).toBe("200");
    expect(r.unitPrice.toFixed(2)).toBe("65.00");
    expect(r.unitCode).toBe("BX");
  });
  it("unidad suelta", () => {
    expect(resolveSaleUnit(p, "UNIT", 7).baseQuantity.toString()).toBe("7");
  });
  it("no permite fracción si el producto no es a granel", () => {
    expect(() => resolveSaleUnit(p, "UNIT", "1.5")).toThrow();
  });
  it("a granel (kg) sí permite fracción", () => {
    expect(resolveSaleUnit({ ...p, allow_fractional: true, units_per_package: 1 }, "UNIT", "2.5").baseQuantity.toString()).toBe("2.5");
  });
});

describe("recetas", () => {
  const today = d("2026-10-14");
  const rx = { id: "x", kind: "SIMPLE" as const, issued_at: d("2026-10-10"), valid_until: null, retained: false, dispensed_at: null, deleted_at: null };
  it("venta libre no requiere receta", () => {
    expect(() => assertPrescriptionValid({ name: "Paracetamol", sale_condition: "FREE", is_controlled: false }, undefined, today)).not.toThrow();
  });
  it("receta retenida debe retenerse", () => {
    expect(() => assertPrescriptionValid({ name: "Ciprofloxacino", sale_condition: "RETAINED_PRESCRIPTION", is_controlled: false }, rx, today)).toThrow(/retenerse/);
  });
  it("controlado exige receta especial vigente", () => {
    expect(() => assertPrescriptionValid({ name: "Clonazepam", sale_condition: "RETAINED_PRESCRIPTION", is_controlled: true }, { ...rx, retained: true }, today)).toThrow(/especial/);
    expect(() => assertPrescriptionValid({ name: "Clonazepam", sale_condition: "RETAINED_PRESCRIPTION", is_controlled: true }, { ...rx, kind: "SPECIAL", retained: true, issued_at: d("2026-10-13") }, today)).not.toThrow();
  });
  it("receta especial no se reutiliza", () => {
    expect(() => assertPrescriptionValid({ name: "Clonazepam", sale_condition: "RETAINED_PRESCRIPTION", is_controlled: true }, { ...rx, kind: "SPECIAL", retained: true, issued_at: d("2026-10-13"), dispensed_at: d("2026-10-13") }, today)).toThrow(/dispensada/);
  });
});

describe("utilidades", () => {
  it.each([
    ["IVERMECTINA 1% 500ML LOTE: A2391 F.V. 31/12/2027", "A2391", "2027-12-31"],
    ["VAC. RABIA LOT 77-B VENC 08/2027", "77-B", "2027-08-31"],
    ["ALIMENTO BALANCEADO 40KG", null, null],
  ])("lote/vencimiento en descripción: %s", (desc, lot, exp) => {
    expect(extractLotExpiry(desc)).toEqual({ lot, expiry: exp });
  });
  it("teléfonos Perú a E.164", () => {
    expect(normalizePeruPhone("987 654 321")).toBe("+51987654321");
    expect(normalizePeruPhone("+51 987654321")).toBe("+51987654321");
    expect(normalizePeruPhone("12345")).toBeNull();
  });
});
