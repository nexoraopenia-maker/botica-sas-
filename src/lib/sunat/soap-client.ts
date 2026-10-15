import JSZip from "jszip";
import { XMLParser } from "fast-xml-parser";
import { escapeXml } from "@/lib/sunat/ubl";

export interface SolCredentials {
  ruc: string;
  user: string; // usuario secundario SOL
  password: string;
}

export interface SoapCallResult {
  httpStatus: number;
  durationMs: number;
  /** Respuesta de sendBill / getStatusCdr: ZIP del CDR en base64 */
  applicationResponse?: string;
  /** Respuesta de sendSummary */
  ticket?: string;
  /** Respuesta de getStatus */
  statusCode?: string;
  content?: string;
  fault?: { code: string; message: string };
}

export class SunatTransportError extends Error {
  constructor(message: string, override readonly cause?: unknown) {
    super(message);
    this.name = "SunatTransportError";
  }
}

const parser = new XMLParser({ removeNSPrefix: true, ignoreAttributes: false, parseTagValue: false });

function envelope(creds: SolCredentials, body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ser="http://service.sunat.gob.pe" xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd">
<soapenv:Header><wsse:Security><wsse:UsernameToken>
<wsse:Username>${escapeXml(creds.ruc + creds.user)}</wsse:Username>
<wsse:Password>${escapeXml(creds.password)}</wsse:Password>
</wsse:UsernameToken></wsse:Security></soapenv:Header>
<soapenv:Body>${body}</soapenv:Body>
</soapenv:Envelope>`;
}

type Json = Record<string, unknown>;
const pick = (o: unknown, ...path: string[]): unknown =>
  path.reduce<unknown>((acc, k) => (acc && typeof acc === "object" ? (acc as Json)[k] : undefined), o);

async function call(endpoint: string, soapAction: string, xml: string, timeoutMs: number): Promise<SoapCallResult> {
  const started = Date.now();
  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "text/xml; charset=utf-8", SOAPAction: soapAction },
      body: xml,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new SunatTransportError(`Error de red con ${endpoint}`, err);
  }
  const text = await res.text();
  const durationMs = Date.now() - started;
  if (res.status >= 500 && !text.includes("Fault")) {
    throw new SunatTransportError(`HTTP ${res.status} desde SUNAT/OSE`);
  }
  let doc: unknown;
  try {
    doc = parser.parse(text);
  } catch (err) {
    throw new SunatTransportError("Respuesta SOAP no es XML válido", err);
  }
  const body = pick(doc, "Envelope", "Body");
  const fault = pick(body, "Fault");
  if (fault) {
    const faultcode = String(pick(fault, "faultcode") ?? "");
    const faultstring = String(pick(fault, "faultstring") ?? "");
    // SUNAT: faultcode "soap-env:Client.0102" o faultstring con el código
    const code = /(\d{4})/.exec(faultcode)?.[1] ?? /(\d{4})/.exec(faultstring)?.[1] ?? "0100";
    return { httpStatus: res.status, durationMs, fault: { code, message: faultstring || faultcode } };
  }
  const result: SoapCallResult = { httpStatus: res.status, durationMs };
  const sendBill = pick(body, "sendBillResponse", "applicationResponse");
  if (typeof sendBill === "string") result.applicationResponse = sendBill;
  const ticket = pick(body, "sendSummaryResponse", "ticket");
  if (typeof ticket === "string") result.ticket = ticket;
  const status = pick(body, "getStatusResponse", "status");
  if (status) {
    result.statusCode = String(pick(status, "statusCode") ?? "");
    const content = pick(status, "content");
    if (typeof content === "string") result.content = content;
  }
  const cdrStatus = pick(body, "getStatusCdrResponse", "statusCdr");
  if (cdrStatus) {
    result.statusCode = String(pick(cdrStatus, "statusCode") ?? "");
    const content = pick(cdrStatus, "content");
    if (typeof content === "string") result.applicationResponse = content;
  }
  return result;
}

export async function zipXml(fileName: string, xml: string): Promise<string> {
  const zip = new JSZip();
  zip.file(`${fileName}.xml`, xml);
  const buf = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  return buf.toString("base64");
}

export class SunatSoapClient {
  constructor(
    private readonly billEndpoint: string,
    private readonly creds: SolCredentials,
    private readonly consultEndpoint = "https://e-factura.sunat.gob.pe/ol-it-wsconscpegem/billConsultService",
    private readonly timeoutMs = 30_000,
  ) {}

  async sendBill(fileName: string, signedXml: string): Promise<SoapCallResult> {
    const content = await zipXml(fileName, signedXml);
    const body = `<ser:sendBill><fileName>${fileName}.zip</fileName><contentFile>${content}</contentFile></ser:sendBill>`;
    return call(this.billEndpoint, "urn:sendBill", envelope(this.creds, body), this.timeoutMs);
  }

  async sendSummary(fileName: string, signedXml: string): Promise<SoapCallResult> {
    const content = await zipXml(fileName, signedXml);
    const body = `<ser:sendSummary><fileName>${fileName}.zip</fileName><contentFile>${content}</contentFile></ser:sendSummary>`;
    return call(this.billEndpoint, "urn:sendSummary", envelope(this.creds, body), this.timeoutMs);
  }

  async getStatus(ticket: string): Promise<SoapCallResult> {
    const body = `<ser:getStatus><ticket>${escapeXml(ticket)}</ticket></ser:getStatus>`;
    return call(this.billEndpoint, "urn:getStatus", envelope(this.creds, body), this.timeoutMs);
  }

  /** Recupera el CDR de un comprobante ya enviado (solo producción). */
  async getStatusCdr(docTypeCode: string, series: string, number: number): Promise<SoapCallResult> {
    const body = `<ser:getStatusCdr><rucComprobante>${this.creds.ruc}</rucComprobante><tipoComprobante>${docTypeCode}</tipoComprobante><serieComprobante>${series}</serieComprobante><numeroComprobante>${number}</numeroComprobante></ser:getStatusCdr>`;
    return call(this.consultEndpoint, "urn:getStatusCdr", envelope(this.creds, body), this.timeoutMs);
  }
}

export interface ParsedCdr {
  responseCode: string;
  description: string;
  notes: string[];
  referenceId: string | null;
  cdrXml: string;
}

/** Descomprime y lee el ApplicationResponse (CDR). */
export async function parseCdrZip(base64Zip: string): Promise<ParsedCdr> {
  const zip = await JSZip.loadAsync(Buffer.from(base64Zip, "base64"));
  const entry = Object.values(zip.files).find((f) => !f.dir && f.name.toLowerCase().endsWith(".xml"));
  if (!entry) throw new Error("CDR sin XML");
  const cdrXml = await entry.async("string");
  const doc = parser.parse(cdrXml);
  const ar = pick(doc, "ApplicationResponse");
  const response = pick(ar, "DocumentResponse", "Response");
  const noteRaw = pick(ar, "Note");
  const notes = (Array.isArray(noteRaw) ? noteRaw : noteRaw !== undefined ? [noteRaw] : []).map((n) =>
    typeof n === "object" && n !== null ? String((n as Json)["#text"] ?? "") : String(n),
  );
  return {
    responseCode: String(pick(response, "ResponseCode") ?? (pick(response, "ResponseCode", "#text") as string) ?? ""),
    description: String(pick(response, "Description") ?? ""),
    notes: notes.filter(Boolean),
    referenceId: (pick(response, "ReferenceID") as string | undefined) ?? null,
    cdrXml,
  };
}
