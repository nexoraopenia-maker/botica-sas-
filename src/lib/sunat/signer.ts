import { SignedXml } from "xml-crypto";
import { SIGNATURE_ID } from "@/lib/sunat/ubl";

export interface SignResult {
  signedXml: string;
  /** DigestValue: "código hash" que va en la representación impresa / QR */
  digestValue: string;
}

export type SignatureProfile = "rsa-sha1" | "rsa-sha256";

const PROFILES = {
  "rsa-sha1": {
    signatureAlgorithm: "http://www.w3.org/2000/09/xmldsig#rsa-sha1",
    digestAlgorithm: "http://www.w3.org/2000/09/xmldsig#sha1",
  },
  "rsa-sha256": {
    signatureAlgorithm: "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
    digestAlgorithm: "http://www.w3.org/2001/04/xmlenc#sha256",
  },
} as const;

/**
 * Firma XMLDSig enveloped dentro de ext:UBLExtensions/ext:UBLExtension/ext:ExtensionContent,
 * con KeyInfo/X509Data, tal como exige SUNAT. Perfil por defecto RSA-SHA1 (máxima
 * compatibilidad SEE-SUNAT/OSE); SHA-256 disponible si el OSE lo acepta.
 */
export function signUbl(
  xml: string,
  privateKeyPem: string,
  certificatePem: string,
  profile: SignatureProfile = "rsa-sha1",
): SignResult {
  const p = PROFILES[profile];
  const sig = new SignedXml({
    privateKey: privateKeyPem,
    publicCert: certificatePem,
    signatureAlgorithm: p.signatureAlgorithm,
    canonicalizationAlgorithm: "http://www.w3.org/TR/2001/REC-xml-c14n-20010315",
  });
  sig.addReference({
    xpath: "/*",
    uri: "",
    isEmptyUri: true,
    digestAlgorithm: p.digestAlgorithm,
    transforms: ["http://www.w3.org/2000/09/xmldsig#enveloped-signature"],
  });
  sig.computeSignature(xml, {
    prefix: "ds",
    attrs: { Id: SIGNATURE_ID },
    location: { reference: "//*[local-name(.)='ExtensionContent']", action: "append" },
  });
  const signedXml = sig.getSignedXml();
  const digestValue = /<ds:DigestValue>([^<]+)<\/ds:DigestValue>/.exec(signedXml)?.[1];
  if (!digestValue) throw new Error("No se pudo obtener DigestValue de la firma");
  return { signedXml, digestValue };
}
