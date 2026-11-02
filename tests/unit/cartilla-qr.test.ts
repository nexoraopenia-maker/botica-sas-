import { describe, expect, it } from "vitest";
import QRCode from "qrcode";
import { PDFDocument } from "pdf-lib";

describe("código QR de la cartilla", () => {
  it("codifica la URL completa de verificación y se puede incrustar en el PDF", async () => {
    const url = `https://app.ejemplo.pe/cartilla/${"a".repeat(36)}.${"b".repeat(32)}`;
    const png = await QRCode.toBuffer(url, { type: "png", margin: 1, width: 300, errorCorrectionLevel: "M" });
    expect(QRCode.create(url, { errorCorrectionLevel: "M" }).modules.size).toBeLessThanOrEqual(45); // legible a 110 pt en papel
    const pdf = await PDFDocument.create();
    const img = await pdf.embedPng(png);
    expect(img.width).toBe(img.height);
  });
});
