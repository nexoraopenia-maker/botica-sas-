import { describe, expect, it } from "vitest";
import { findSubstitutes, matchesSearch, type PharmaProduct } from "@/lib/pharmacy/substitutes";
import { computeLine, computeTotals } from "@/lib/sunat/totals";

const base: PharmaProduct = {
  id: "x", name: "", sku: "", barcode: null, dci: null, concentration: null, pharmaceuticalForm: null, laboratory: null, therapeuticAction: null,
  pharmaceuticalKind: null, salePrice: "1.00", available: "10", tracksBatches: true, isService: false,
};
const p = (o: Partial<PharmaProduct>): PharmaProduct => ({ ...base, ...o });

const panadol = p({ id: "1", name: "Panadol 500 mg", sku: "PAN", dci: "Paracetamol", concentration: "500 mg", pharmaceuticalForm: "Tableta", therapeuticAction: "Analgésico, antipirético", laboratory: "GSK", pharmaceuticalKind: "BRAND", salePrice: "1.50" });
const generico = p({ id: "2", name: "Paracetamol MK 500mg", sku: "PMK", dci: "PARACETAMOL", concentration: "500MG", pharmaceuticalForm: "tableta", pharmaceuticalKind: "GENERIC", salePrice: "0.30" });
const otro = p({ id: "3", name: "Paracetamol 1 g", sku: "P1G", dci: "Paracetamol", concentration: "1 g", pharmaceuticalForm: "Tableta", pharmaceuticalKind: "GENERIC", salePrice: "0.60" });
const agotado = p({ id: "4", name: "Paracetamol Genfar", sku: "PGF", dci: "Paracetamol", concentration: "500 mg", pharmaceuticalForm: "Tableta", pharmaceuticalKind: "GENERIC", salePrice: "0.20", available: "0" });
const ibuprofeno = p({ id: "5", name: "Ibuprofeno 400", sku: "IBU", dci: "Ibuprofeno", concentration: "400 mg", pharmaceuticalForm: "Tableta", therapeuticAction: "Antiinflamatorio, analgésico", salePrice: "0.40" });

describe("búsqueda farmacológica", () => {
  it("encuentra por nombre, principio activo, acción terapéutica y laboratorio, sin tildes", () => {
    expect(matchesSearch(panadol, "panadol")).toBe(true);
    expect(matchesSearch(panadol, "PARACETAMOL")).toBe(true);
    expect(matchesSearch(panadol, "analgesico")).toBe(true);
    expect(matchesSearch(panadol, "antipiretico")).toBe(true);
    expect(matchesSearch(panadol, "gsk")).toBe(true);
    expect(matchesSearch(ibuprofeno, "antiinflamatorio")).toBe(true);
    expect(matchesSearch(ibuprofeno, "antibiotico")).toBe(false);
  });
  it("combina palabras en cualquier orden", () => {
    expect(matchesSearch(panadol, "analgesico paracetamol")).toBe(true);
    expect(matchesSearch(panadol, "analgesico ibuprofeno")).toBe(false);
  });
  it("búsqueda vacía muestra todo", () => {
    expect(matchesSearch(panadol, "   ")).toBe(true);
  });
});

describe("genéricos y sustitutos", () => {
  const catalogo = [panadol, generico, otro, agotado, ibuprofeno];
  it("mismo principio activo, concentración y forma, con stock, y el más barato primero", () => {
    const r = findSubstitutes(panadol, catalogo);
    expect(r.map((s) => s.product.id)).toEqual(["2"]);
    expect(r[0]!.saving).toBe(1.2);
  });
  it("tolera mayúsculas y espacios en la concentración", () => {
    expect(findSubstitutes(panadol, [generico]).map((s) => s.product.id)).toEqual(["2"]);
  });
  it("no sugiere otra concentración, otro principio activo ni productos agotados", () => {
    const ids = findSubstitutes(panadol, catalogo).map((s) => s.product.id);
    expect(ids).not.toContain("3");
    expect(ids).not.toContain("4");
    expect(ids).not.toContain("5");
  });
  it("sin DCI no hay sustitutos", () => {
    expect(findSubstitutes(p({ id: "9", name: "Curita" }), catalogo)).toEqual([]);
  });
  it("genéricos antes que marcas, aunque la marca sea más barata", () => {
    const marca = p({ ...panadol, id: "6", name: "Otra marca", salePrice: "0.10" });
    expect(findSubstitutes(panadol, [marca, generico]).map((s) => s.product.id)).toEqual(["2", "6"]);
  });
});

describe("ICBPER en el desglose", () => {
  it("la bolsa suma S/ 0.50 al total y aparece aparte del IGV", () => {
    const bolsa = computeLine({ quantity: 2, unitPrice: "0.00", affectation: "10", icbperUnits: 2 });
    const pastilla = computeLine({ quantity: 1, unitPrice: "11.80", affectation: "10" });
    const t = computeTotals([pastilla, bolsa]);
    expect(t.icbper.toFixed(2)).toBe("1.00");
    expect(t.igv.toFixed(2)).toBe("1.80");
    expect(t.opGravadas.toFixed(2)).toBe("10.00");
    expect(t.total.toFixed(2)).toBe("12.80");
  });
  it("una bolsa con precio paga IGV sobre el precio y ICBPER aparte", () => {
    const l = computeLine({ quantity: 1, unitPrice: "0.59", affectation: "10", icbperUnits: 1 });
    expect(l.icbper.toFixed(2)).toBe("0.50");
    expect(l.lineTotal.toFixed(2)).toBe("1.09");
    expect(l.igv.toFixed(2)).toBe("0.09");
  });
});
