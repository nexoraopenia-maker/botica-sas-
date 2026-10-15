import { describe, expect, it } from "vitest";
import { computeLine, computeTotals } from "@/lib/sunat/totals";
import { amountInWords, integerToWords } from "@/lib/sunat/amount-in-words";
import { D } from "@/lib/money";

describe("computeLine (precio con IGV)", () => {
  it("gravado: total exacto = qty × precio y IGV cuadra", () => {
    const l = computeLine({ quantity: 3, unitPrice: "11.80", affectation: "10" });
    expect(l.lineTotal.toFixed(2)).toBe("35.40");
    expect(l.lineExtension.toFixed(2)).toBe("30.00");
    expect(l.igv.toFixed(2)).toBe("5.40");
    expect(l.unitValue.toFixed(10)).toBe("10.0000000000");
  });

  it("gravado con redondeo: base + IGV = total cobrado", () => {
    const l = computeLine({ quantity: 7, unitPrice: "3.50", affectation: "10" });
    expect(l.lineTotal.toFixed(2)).toBe("24.50");
    expect(l.lineExtension.plus(l.igv).toFixed(2)).toBe("24.50");
  });

  it("exonerado (Apéndice I Ley del IGV) sin IGV", () => {
    const l = computeLine({ quantity: 2, unitPrice: "45.00", affectation: "20" });
    expect(l.igv.toFixed(2)).toBe("0.00");
    expect(l.lineExtension.toFixed(2)).toBe("90.00");
  });

  it("gratuito (bonificación 11): no suma al total, informa valor referencial", () => {
    const l = computeLine({ quantity: 1, unitPrice: "11.80", affectation: "11" });
    expect(l.free).toBe(true);
    expect(l.lineTotal.toFixed(2)).toBe("0.00");
    expect(l.lineExtension.toFixed(2)).toBe("10.00");
  });

  it("descuento con IGV incluido", () => {
    const l = computeLine({ quantity: 1, unitPrice: "118.00", affectation: "10", discount: "11.80" });
    expect(l.lineTotal.toFixed(2)).toBe("106.20");
    expect(l.discount.toFixed(2)).toBe("10.00");
  });

  it("ICBPER S/ 0.50 por bolsa", () => {
    const l = computeLine({ quantity: 2, unitPrice: "0.00", affectation: "10", icbperUnits: 2 });
    expect(l.icbper.toFixed(2)).toBe("1.00");
  });

  it("rechaza descuento mayor al importe", () => {
    expect(() => computeLine({ quantity: 1, unitPrice: 10, affectation: "10", discount: 11 })).toThrow();
  });
});

describe("computeTotals", () => {
  it("separa gravadas, exoneradas y gratuitas", () => {
    const t = computeTotals([
      computeLine({ quantity: 1, unitPrice: "118", affectation: "10" }),
      computeLine({ quantity: 1, unitPrice: "50", affectation: "20" }),
      computeLine({ quantity: 1, unitPrice: "11.8", affectation: "11" }),
    ]);
    expect(t.opGravadas.toFixed(2)).toBe("100.00");
    expect(t.opExoneradas.toFixed(2)).toBe("50.00");
    expect(t.opGratuitas.toFixed(2)).toBe("10.00");
    expect(t.igv.toFixed(2)).toBe("18.00");
    expect(t.total.toFixed(2)).toBe("168.00");
  });
});

describe("monto en letras (leyenda 1000)", () => {
  it.each([
    [0, "CERO"], [1, "UNO"], [16, "DIECISEIS"], [21, "VEINTIUNO"], [100, "CIEN"], [101, "CIENTO UNO"],
    [1000, "MIL"], [1001, "MIL UNO"], [21000, "VEINTIUN MIL"], [1_000_000, "UN MILLON"], [2_500_000, "DOS MILLONES QUINIENTOS MIL"],
  ])("%i → %s", (n, w) => expect(integerToWords(n)).toBe(w));

  it("con céntimos y moneda", () => {
    expect(amountInWords(D("118.50"))).toBe("SON CIENTO DIECIOCHO CON 50/100 SOLES");
  });
});
