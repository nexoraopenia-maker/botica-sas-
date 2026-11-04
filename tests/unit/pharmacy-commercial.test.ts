import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { D } from "@/lib/money";
import { formatStock, resolveSaleUnit } from "@/lib/pharmacy/fractioning";
import { expiryWarning, lotProblem } from "@/lib/inventory/expiry-rules";
import { creditNoteEffect, earnAmount } from "@/lib/loyalty/calc";
import { controlledCsv, observatoryXlsx, type ControlledRow } from "@/lib/reports/digemid-format";
import { permissionForPath } from "@/lib/modules/registry";

const box = { name: "Paracetamol", unit_code: "NIU", sale_price: D("0.50"), package_price: D("80"), units_per_package: 200, units_per_blister: 10, blister_price: D("4.50"), package_unit_code: "BX", allow_fractional: false };

describe("fraccionamiento: caja de 20 blísteres de 10 pastillas", () => {
  it("convierte cada presentación a unidad base con su precio", () => {
    expect(resolveSaleUnit(box, "UNIT", 3)).toMatchObject({ unitCode: "NIU" });
    expect(resolveSaleUnit(box, "UNIT", 3).baseQuantity.toNumber()).toBe(3);
    const b = resolveSaleUnit(box, "BLISTER", 2);
    expect(b.baseQuantity.toNumber()).toBe(20);
    expect(b.unitPrice.toNumber()).toBe(4.5);
    const c = resolveSaleUnit(box, "PACKAGE", 1);
    expect(c.baseQuantity.toNumber()).toBe(200);
    expect(c.unitPrice.toNumber()).toBe(80);
  });
  it("sin precio de blíster usa el proporcional", () => {
    expect(resolveSaleUnit({ ...box, blister_price: null }, "BLISTER", 1).unitPrice.toNumber()).toBe(5);
  });
  it("rechaza blíster si el producto no lo tiene o la cantidad no es entera", () => {
    expect(() => resolveSaleUnit({ ...box, units_per_blister: 1 }, "BLISTER", 1)).toThrow(/blíster/);
    expect(() => resolveSaleUnit(box, "BLISTER", 1.5)).toThrow(/entera/);
  });
  it("muestra el stock por presentación", () => {
    expect(formatStock(D(635), 200, 10)).toBe("3 emp. + 3 blíst. + 5 unid.");
    expect(formatStock(D(25), 1, 10)).toBe("2 blíst. + 5 unid.");
    expect(formatStock(D(25), 100)).toBe("0 emp. + 25 unid.");
    expect(formatStock(D(25), 1)).toBe("25");
  });
});

describe("lotes y vencimientos", () => {
  const today = "2026-11-04";
  it("avisa dentro de 30 días, no antes", () => {
    expect(expiryWarning("2026-12-04", today)).toEqual({ days: 30, label: "Vence en 30 d" });
    expect(expiryWarning("2026-12-05", today)).toBeNull();
    expect(expiryWarning("2026-11-04", today)?.label).toBe("Vence hoy");
    expect(expiryWarning(null, today)).toBeNull();
  });
  it("una compra exige lote y vencimiento vigentes", () => {
    expect(lotProblem({ lotCode: " ", expiryDate: "2027-01-01" }, today)).toMatch(/lote/);
    expect(lotProblem({ lotCode: "L1" }, today)).toMatch(/vencimiento/);
    expect(lotProblem({ lotCode: "L1", expiryDate: today }, today)).toMatch(/vencido/);
    expect(lotProblem({ lotCode: "L1", expiryDate: "2026-11-05" }, today)).toBeNull();
  });
});

describe("monedero", () => {
  it("gana un % solo de lo pagado con dinero", () => {
    expect(earnAmount("100", "0", "2").toFixed(2)).toBe("2.00");
    expect(earnAmount("100", "40", "2").toFixed(2)).toBe("1.20");
    expect(earnAmount("100", "100", "2").toFixed(2)).toBe("0.00");
    expect(earnAmount("33.33", "0", "1.5").toFixed(2)).toBe("0.50");
  });
  it("una devolución parcial revierte en proporción", () => {
    const r = creditNoteEffect({ noteTotal: "50", saleTotal: "100", earned: "2", redeemed: "10", balance: "5" });
    expect(r.reverse.toFixed(2)).toBe("1.00");
    expect(r.refund.toFixed(2)).toBe("5.00");
  });
  it("si el cliente ya gastó lo ganado, no deja saldo negativo", () => {
    const r = creditNoteEffect({ noteTotal: "100", saleTotal: "100", earned: "10", redeemed: "0", balance: "3" });
    expect(r.reverse.toFixed(2)).toBe("3.00");
    expect(r.refund.toFixed(2)).toBe("0.00");
  });
});

describe("reportes DIGEMID", () => {
  it("el Excel lleva hoja Hoja1, columnas exactas y códigos como texto", async () => {
    const buf = await observatoryXlsx([{ establishment: "0012345", productCode: "01234", packagePrice: "80", unitPrice: "0.5" }]);
    const zip = await JSZip.loadAsync(buf);
    expect(await zip.file("xl/workbook.xml")!.async("string")).toContain('name="Hoja1"');
    const sheet = await zip.file("xl/worksheets/sheet1.xml")!.async("string");
    for (const h of ["CodEstab", "CodProd", "Precio 1", "Precio 2", "0012345", "01234"]) expect(sheet).toContain(`<t>${h}</t>`);
    expect(sheet).toContain("<v>80.00</v>");
    expect(sheet).toContain("<v>0.50</v>");
  });
  const row: ControlledRow = {
    occurredAt: "4/11/2026", product: "Diazepam; 10 mg", dci: null, list: "IIIC", lot: "L1", expiry: "2027-01-01", movement: "Salida", quantity: "1", balance: "9",
    document: "B001-1", purchase: null, rxKind: "SPECIAL", rxDate: "2026-11-04", patient: "=HYPERLINK(1)", prescriber: "Dra. Rojas", prescriberCmp: "4567", prescriberDoc: "12345678", counterparty: null, recordedBy: "QF",
  };
  it("el CSV incluye lote y receta, y neutraliza fórmulas", () => {
    const csv = controlledCsv([row]);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toContain('"Diazepam; 10 mg"');
    expect(csv).toContain(";L1;2027-01-01;");
    expect(csv).toContain(";Dra. Rojas;4567;12345678;");
    expect(csv).toContain(";'=HYPERLINK(1);");
    expect(csv.split("\r\n")[0]!.split(";")).toHaveLength(19);
  });
  it("cada ruta exige su permiso", () => {
    expect(permissionForPath("/app/reports/digemid")).toBe("pharmacy.controlled_log");
    expect(permissionForPath("/app/reports/commissions")).toBe("reports.read");
    expect(permissionForPath("/app/settings/loyalty")).toBe("settings.manage");
  });
});
