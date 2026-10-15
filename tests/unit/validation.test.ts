import { describe, expect, it } from "vitest";
import { isValidRuc, validateDocumentRules } from "@/lib/sunat/validation";
import { classifySunatCode } from "@/lib/sunat/errors";
import { D } from "@/lib/money";

const today = new Date("2026-10-14T00:00:00Z");
const base = {
  series: "B001", issueDate: today, today, customerDocType: "NO_DOC" as const, customerDocNumber: "-",
  customerName: "CLIENTES VARIOS", paymentTerms: "Contado" as const,
};

describe("RUC", () => {
  it("dígito verificador módulo 11", () => {
    expect(isValidRuc("20131312955")).toBe(true);
    expect(isValidRuc("20131312954")).toBe(false);
    expect(isValidRuc("30131312955")).toBe(false);
  });
});

describe("reglas de comprobante", () => {
  it("boleta ≤ 700 sin DNI es válida", () => {
    expect(validateDocumentRules({ ...base, docType: "BOLETA", total: D("700.00") })).toEqual([]);
  });

  it("boleta > 700 exige identificar al adquirente", () => {
    const issues = validateDocumentRules({ ...base, docType: "BOLETA", total: D("700.01") });
    expect(issues.map((i) => i.code)).toContain("BOLETA_OVER_700_REQUIRES_ID");
  });

  it("boleta > 700 con DNI es válida", () => {
    expect(validateDocumentRules({ ...base, docType: "BOLETA", total: D(900), customerDocType: "DNI", customerDocNumber: "45678912", customerName: "JUAN PEREZ" })).toEqual([]);
  });

  it("factura requiere RUC válido y serie F", () => {
    const issues = validateDocumentRules({ ...base, docType: "FACTURA", series: "B001", total: D(10) });
    expect(issues.map((i) => i.code)).toEqual(expect.arrayContaining(["SERIES_FORMAT", "FACTURA_REQUIRES_RUC"]));
  });

  it("fuera de plazo de envío", () => {
    const issues = validateDocumentRules({ ...base, docType: "BOLETA", total: D(10), issueDate: new Date("2026-10-01T00:00:00Z") });
    expect(issues.map((i) => i.code)).toContain("LATE_ISSUE");
  });

  it("NC: misma letra de serie y referencia aceptada", () => {
    const issues = validateDocumentRules({
      ...base, docType: "NOTA_CREDITO", series: "FC01", total: D(10),
      reference: { docType: "BOLETA", series: "B001", status: "RECHAZADO", reasonCode: "01", total: D(10) },
    });
    expect(issues.map((i) => i.code)).toEqual(expect.arrayContaining(["NOTE_SERIES_PREFIX", "NOTE_REFERENCE_STATUS"]));
  });
});

describe("clasificación de respuestas SUNAT", () => {
  it.each([
    ["0", [], "ACCEPTED"],
    ["0", ["4252 - observación"], "ACCEPTED_WITH_OBS"],
    ["2800", [], "REJECTED"],
    ["0109", [], "RETRYABLE"],
    ["0102", [], "CONFIG_ERROR"],
    ["1033", [], "ALREADY_REGISTERED"],
    ["4093", [], "ACCEPTED_WITH_OBS"],
    ["soap-env:Client.0111", [], "CONFIG_ERROR"],
  ])("%s → %s", (code, notes, kind) => {
    expect(classifySunatCode(code, "x", notes as string[]).kind).toBe(kind);
  });
});
