import { describe, expect, it } from "vitest";
import { pleFile, pleFileName, purchaseLine, saleLine, type PleSale } from "@/lib/reports/ple-format";

const base: PleSale = {
  docCode: "03", series: "B001", number: 15, issueDate: new Date("2026-10-05T00:00:00Z"),
  customerDocCode: "1", customerDoc: "12345678", customerName: "JUAN | PEREZ", gravada: "100.00", exonerada: "20.00", inafecta: "0",
  igv: "18.00", icbper: "0.50", total: "138.50", voided: false, ref: null,
};
const cells = (l: string) => { expect(l.endsWith("|")).toBe(true); return l.slice(0, -1).split("|"); };

describe("PLE 14.1 Registro de Ventas", () => {
  it("genera 35 campos en las posiciones de SUNAT", () => {
    const f = cells(saleLine(base, "2026-10", 7));
    expect(f).toHaveLength(35);
    expect(f[0]).toBe("20261000");
    expect(f[2]).toBe("M7");
    expect(f[3]).toBe("05/10/2026");
    expect(f[5]).toBe("03");
    expect(f[6]).toBe("B001");
    expect(f[7]).toBe("15");
    expect(f[11]).toBe("JUAN PEREZ"); // sin separadores dentro del texto
    expect(f[13]).toBe("100.00"); // 14 base imponible
    expect(f[15]).toBe("18.00"); // 16 IGV
    expect(f[17]).toBe("20.00"); // 18 exonerada
    expect(f[22]).toBe("0.50"); // 23 ICBPER
    expect(f[24]).toBe("138.50"); // 25 total
    expect(f[25]).toBe("PEN");
    expect(f[34]).toBe("1"); // 35 estado
  });

  it("nota de crédito: montos negativos y referencia al comprobante", () => {
    const f = cells(saleLine({ ...base, docCode: "07", ref: { date: new Date("2026-09-30T00:00:00Z"), docCode: "03", series: "B001", number: 9 } }, "2026-10", 1));
    expect(f[13]).toBe("-100.00");
    expect(f[24]).toBe("-138.50");
    expect(f.slice(27, 31)).toEqual(["30/09/2026", "03", "B001", "9"]);
  });

  it("anulado: estado 2 y montos en cero", () => {
    const f = cells(saleLine({ ...base, voided: true }, "2026-10", 1));
    expect(f[34]).toBe("2");
    expect(f[24]).toBe("0.00");
    expect(f[11]).toBe("");
  });
});

describe("PLE 8.1 Registro de Compras", () => {
  const p = {
    docCode: "01", series: "F001", number: "88", issueDate: new Date("2026-10-02T00:00:00Z"), supplierRuc: "20123456789", supplierName: "DROGUERIA SAC",
    nonTaxable: "10.00", subtotal: "110.00", igv: "18.00", total: "128.00", currency: "PEN", exchangeRate: null,
  };
  it("factura: 42 campos, crédito fiscal y total igual a la suma de los campos 14 a 23", () => {
    const f = cells(purchaseLine(p, "2026-10", 1));
    expect(f).toHaveLength(42);
    expect(f[13]).toBe("100.00");
    expect(f[14]).toBe("18.00");
    expect(f[19]).toBe("10.00");
    expect(f[23]).toBe("128.00");
    expect(f.slice(13, 23).reduce((a, v) => a + Number(v), 0)).toBeCloseTo(Number(f[23]), 2);
    expect(f[41]).toBe("1");
  });
  it("boleta: sin crédito fiscal (estado 0), todo como no gravado", () => {
    const f = cells(purchaseLine({ ...p, docCode: "03" }, "2026-10", 1));
    expect(f[13]).toBe("0.00");
    expect(f[19]).toBe("128.00");
    expect(f[41]).toBe("0");
  });
  it("moneda extranjera: montos en soles, con moneda y tipo de cambio", () => {
    const f = cells(purchaseLine({ ...p, currency: "USD", exchangeRate: "3.8", nonTaxable: "0", subtotal: "100", igv: "18", total: "118" }, "2026-10", 1));
    expect(f[23]).toBe("448.40");
    expect(f[24]).toBe("USD");
    expect(f[25]).toBe("3.800");
  });
});

describe("Archivo PLE", () => {
  it("nombre según la regla de SUNAT (33 posiciones + extensión)", () => {
    const n = pleFileName("20123456789", "2026-10", "sales", true);
    expect(n).toBe("LE2012345678920261000140100001111.TXT");
    expect(n.replace(".TXT", "")).toHaveLength(33);
    expect(pleFileName("20123456789", "2026-10", "purchases", false)).toBe("LE2012345678920261000080100001011.TXT");
  });
  it("usa CRLF y queda vacío sin operaciones", () => {
    expect(pleFile(["a|", "b|"]).toString("latin1")).toBe("a|\r\nb|\r\n");
    expect(pleFile([])).toHaveLength(0);
  });
});
