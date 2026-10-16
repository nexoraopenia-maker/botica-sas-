import { describe, expect, it } from "vitest";
import { isValidGtin, looksLikeBrokenGtin } from "@/lib/inventory/barcode";

describe("códigos de barras GTIN", () => {
  it.each(["2000000000015", "7750182002240", "96385074", "036000291452"])("válido %s", (c) => expect(isValidGtin(c)).toBe(true));
  it.each(["2000000000016", "7750182002241", "12345"])("inválido %s", (c) => expect(isValidGtin(c)).toBe(false));
  it("códigos internos alfanuméricos no se marcan como GTIN roto", () => {
    expect(looksLikeBrokenGtin("IVER-500")).toBe(false);
    expect(looksLikeBrokenGtin("2000000000016")).toBe(true);
  });
});
