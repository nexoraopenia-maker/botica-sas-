import forge from "node-forge";

export interface LoadedCertificate {
  privateKeyPem: string;
  certificatePem: string;
  subject: string;
  serialNumber: string;
  notBefore: Date;
  notAfter: Date;
  /** SHA-256 del certificado DER (hex) */
  fingerprint: string;
  /** RUC encontrado en el subject (si lo tiene) */
  rucInSubject: string | null;
}

/** Abre un .pfx/.p12 y extrae llave privada + certificado de firma. */
export function loadPfx(pfx: Buffer, password: string): LoadedCertificate {
  const asn1 = forge.asn1.fromDer(forge.util.createBuffer(pfx.toString("binary")));
  const p12 = forge.pkcs12.pkcs12FromAsn1(asn1, false, password);

  const OID_SHROUDED = forge.pki.oids["pkcs8ShroudedKeyBag"] as string;
  const OID_KEY = forge.pki.oids["keyBag"] as string;
  const OID_CERT = forge.pki.oids["certBag"] as string;
  const keyBags: forge.pkcs12.Bag[] =
    p12.getBags({ bagType: OID_SHROUDED })[OID_SHROUDED] ?? p12.getBags({ bagType: OID_KEY })[OID_KEY] ?? [];
  const key = keyBags[0]?.key;
  if (!key) throw new Error("El .pfx no contiene llave privada");

  const certBags: forge.pkcs12.Bag[] = p12.getBags({ bagType: OID_CERT })[OID_CERT] ?? [];
  // El certificado de firma es el que corresponde a la llave privada (no las CAs de la cadena)
  const keyModulus = (key as forge.pki.rsa.PrivateKey).n.toString(16);
  const cert =
    certBags.map((b) => b.cert).find((c): c is forge.pki.Certificate =>
      !!c && (c.publicKey as forge.pki.rsa.PublicKey).n.toString(16) === keyModulus,
    ) ?? certBags[0]?.cert;
  if (!cert) throw new Error("El .pfx no contiene certificado");

  const der = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes();
  const md = forge.md.sha256.create();
  md.update(der);

  const subject = cert.subject.attributes.map((a: forge.pki.CertificateField) => `${a.shortName ?? a.name}=${String(a.value)}`).join(", ");
  const ruc = /(?:^|\D)((?:10|15|16|17|20)\d{9})(?:\D|$)/.exec(subject)?.[1] ?? null;

  return {
    privateKeyPem: forge.pki.privateKeyToPem(key),
    certificatePem: forge.pki.certificateToPem(cert),
    subject,
    serialNumber: cert.serialNumber,
    notBefore: cert.validity.notBefore,
    notAfter: cert.validity.notAfter,
    fingerprint: md.digest().toHex(),
    rucInSubject: ruc,
  };
}

/**
 * Certificado en PEM (llave privada + certificado, p. ej. exportado con openssl) → PKCS#12 en memoria,
 * para guardar y usar un único formato. La llave puede venir cifrada (ENCRYPTED PRIVATE KEY) con `password`.
 */
export function pemToPfx(pem: string, password: string): Buffer {
  const certs = [...pem.matchAll(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g)].map((m) => forge.pki.certificateFromPem(m[0]));
  if (certs.length === 0) throw new Error("El PEM no contiene un certificado (BEGIN CERTIFICATE).");
  const keyBlock = /-----BEGIN (ENCRYPTED |RSA )?PRIVATE KEY-----[\s\S]+?-----END (ENCRYPTED |RSA )?PRIVATE KEY-----/.exec(pem)?.[0];
  if (!keyBlock) throw new Error("El PEM no contiene la llave privada (BEGIN PRIVATE KEY).");
  const key = keyBlock.includes("ENCRYPTED")
    ? forge.pki.decryptRsaPrivateKey(keyBlock, password)
    : forge.pki.privateKeyFromPem(keyBlock);
  if (!key) throw new Error("No se pudo descifrar la llave privada: contraseña incorrecta.");
  const p12 = forge.pkcs12.toPkcs12Asn1(key, certs, password, { algorithm: "aes256" });
  return Buffer.from(forge.asn1.toDer(p12).getBytes(), "binary");
}

/** Acepta .pfx/.p12 (binario) o .pem (texto) y devuelve siempre PKCS#12. */
export function normalizeCertificateFile(file: Buffer, fileName: string, password: string): Buffer {
  const head = file.subarray(0, 64).toString("utf8");
  const isPem = /\.pem$|\.crt$|\.key$/i.test(fileName) || head.includes("-----BEGIN");
  return isPem ? pemToPfx(file.toString("utf8"), password) : file;
}
