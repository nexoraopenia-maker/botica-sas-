import { describe, expect, it } from "vitest";
import { SignedXml } from "xml-crypto";
import { XMLParser } from "fast-xml-parser";
import { computeLine, computeTotals } from "@/lib/sunat/totals";
import { buildUbl, type UblDocumentInput } from "@/lib/sunat/ubl";
import { signUbl } from "@/lib/sunat/signer";
import { loadPfx } from "@/lib/sunat/certificate";
import { parseSupplierUbl } from "@/lib/ai/ingestion/xml-ubl";
import { LocalKekProvider, open, seal } from "@/lib/crypto/envelope";
import { makeTestPfx } from "../support/cert";

const lines = [
  computeLine({ quantity: 2, unitPrice: "59.00", affectation: "10" }),
  computeLine({ quantity: 1, unitPrice: "45.00", affectation: "20" }),
];
const doc: UblDocumentInput = {
  docType: "FACTURA", series: "F001", number: 123, issueDate: "2026-10-14", issueTime: "10:15:00", currency: "PEN",
  operationType: "0101", paymentTerms: "Contado",
  issuer: {
    ruc: "20131312955", legalName: "AGRO & VET <PRUEBA> S.A.C.", tradeName: "AgroVet", address: "Av. Siempre Viva 123",
    ubigeo: "150101", department: "LIMA", province: "LIMA", district: "LIMA", establishmentCode: "0000",
  },
  customer: { docType: "RUC", docNumber: "20100070970", name: "CLIENTE SAC" },
  lines: [
    { totals: lines[0]!, description: "IVERMECTINA 1% 500ML LOTE: A2391 F.V. 31/12/2027", unitCode: "NIU", sku: "IVER-500" },
    { totals: lines[1]!, description: "SEMILLA DE MAIZ ]]> 1KG", unitCode: "KGM", sku: "MAIZ-1" },
  ],
  totals: computeTotals(lines),
};

describe("UBL 2.1", () => {
  const xml = buildUbl(doc);
  const parsed = new XMLParser({ removeNSPrefix: true, ignoreAttributes: false }).parse(xml);

  it("estructura de Invoice con totales correctos", () => {
    const inv = parsed.Invoice;
    expect(inv.ID).toBe("F001-123");
    expect(inv.InvoiceTypeCode["#text"]).toBe(1); // "01"
    expect(inv.LegalMonetaryTotal.PayableAmount["#text"]).toBe(163);
    expect(inv.TaxTotal.TaxAmount["#text"]).toBe(18);
    expect(inv.InvoiceLine).toHaveLength(2);
    expect(xml).toContain("AGRO &amp; VET &lt;PRUEBA&gt; S.A.C.");
    expect(xml).toContain("SON CIENTO SESENTA Y TRES CON 00/100 SOLES");
    expect(xml).toContain("<cbc:ID>FormaPago</cbc:ID>");
  });

  it("parser de XML de proveedor recupera líneas, lote y vencimiento", () => {
    const back = parseSupplierUbl(xml);
    expect(back.supplier.ruc).toBe("20131312955");
    expect(back.series).toBe("F001");
    expect(back.items[0]).toMatchObject({ quantity: "2", unit_price: "50.0000000000", lot_code: "A2391", expiry_date: "2027-12-31", igv_affectation: "GRAVADO" });
    expect(back.items[1]?.igv_affectation).toBe("EXONERADO");
  });

  it("firma XMLDSig enveloped en ExtensionContent y verificable", () => {
    const pfx = makeTestPfx("20131312955", "secreto");
    const cert = loadPfx(pfx, "secreto");
    expect(cert.rucInSubject).toBe("20131312955");
    const { signedXml, digestValue } = signUbl(xml, cert.privateKeyPem, cert.certificatePem);
    expect(signedXml).toMatch(/<ext:ExtensionContent><ds:Signature[^>]*Id="SignatureSP"/);
    expect(digestValue.length).toBeGreaterThan(20);

    const verifier = new SignedXml({ publicCert: cert.certificatePem });
    const sigNode = /<ds:Signature[\s\S]*<\/ds:Signature>/.exec(signedXml)![0];
    verifier.loadSignature(sigNode);
    expect(verifier.checkSignature(signedXml)).toBe(true);

    const tampered = signedXml.replace("<cbc:ID>F001-123</cbc:ID>", "<cbc:ID>F001-124</cbc:ID>");
    const v2 = new SignedXml({ publicCert: cert.certificatePem });
    v2.loadSignature(sigNode);
    let valid: boolean;
    try {
      valid = v2.checkSignature(tampered);
    } catch {
      valid = false;
    }
    expect(valid).toBe(false);
  });

  it("contraseña de .pfx incorrecta falla", () => {
    expect(() => loadPfx(makeTestPfx("20131312955", "ok"), "mal")).toThrow();
  });
});

describe("envelope encryption", () => {
  const kp = new LocalKekProvider(Buffer.alloc(32, 7).toString("base64"), "test-v1");
  it("cifra y descifra con AAD por tenant", async () => {
    const s = await seal(Buffer.from("clave-sol"), "tenant:A|kind:SOL", kp);
    expect((await open(s, "tenant:A|kind:SOL", kp)).toString()).toBe("clave-sol");
  });
  it("un ciphertext movido a otro tenant no descifra", async () => {
    const s = await seal(Buffer.from("clave-sol"), "tenant:A|kind:SOL", kp);
    await expect(open(s, "tenant:B|kind:SOL", kp)).rejects.toThrow();
  });
});
