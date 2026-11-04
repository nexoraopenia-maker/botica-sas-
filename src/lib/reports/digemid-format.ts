import JSZip from "jszip";

/** Salida pura de los reportes DIGEMID: sin acceso a datos, para poder probarla. */
export interface ObservatoryRow { establishment: string; productCode: string; packagePrice: string; unitPrice: string }

const xml = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const text = (ref: string, v: string) => `<c r="${ref}" t="inlineStr"><is><t>${xml(v)}</t></is></c>`;
const price = (ref: string, v: string) => `<c r="${ref}" s="1"><v>${Number(v).toFixed(2)}</v></c>`;

/**
 * Archivo de carga al Observatorio de Precios: hoja "Hoja1" con CodEstab, CodProd, Precio 1 (empaque) y Precio 2 (unidad).
 * Los códigos van como texto porque algunos empiezan con cero. Generado con jszip para no sumar dependencias.
 */
export async function observatoryXlsx(rows: ObservatoryRow[]): Promise<Buffer> {
  const header = `<row r="1">${["CodEstab", "CodProd", "Precio 1", "Precio 2"].map((h, i) => text(`${"ABCD"[i]}1`, h)).join("")}</row>`;
  const body = rows.map((r, i) => {
    const n = i + 2;
    return `<row r="${n}">${text(`A${n}`, r.establishment)}${text(`B${n}`, r.productCode)}${price(`C${n}`, r.packagePrice)}${price(`D${n}`, r.unitPrice)}</row>`;
  }).join("");
  const head = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `${head}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`);
  zip.file("_rels/.rels", `${head}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
  zip.file("xl/workbook.xml", `${head}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Hoja1" sheetId="1" r:id="rId1"/></sheets></workbook>`);
  zip.file("xl/_rels/workbook.xml.rels", `${head}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`);
  zip.file("xl/styles.xml", `${head}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="2" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs></styleSheet>`);
  zip.file("xl/worksheets/sheet1.xml", `${head}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${header}${body}</sheetData></worksheet>`);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

export interface ControlledRow {
  occurredAt: string; product: string; dci: string | null; list: string | null; lot: string | null; expiry: string | null;
  movement: string; quantity: string; balance: string; document: string | null; purchase: string | null;
  rxKind: string | null; rxDate: string | null; patient: string | null; prescriber: string | null; prescriberCmp: string | null; prescriberDoc: string | null;
  counterparty: string | null; recordedBy: string | null;
}

/** Excel ejecuta como fórmula lo que empieza con estos signos: se neutraliza al exportar. */
const csvCell = (v: string | null): string => {
  const s = v ?? "";
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",;\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};
const CONTROLLED_HEADER = ["Fecha", "Producto", "DCI", "Lista", "Lote", "Vencimiento", "Movimiento", "Cantidad", "Saldo", "Comprobante", "Compra", "Tipo de receta", "Fecha de receta", "Paciente", "Prescriptor", "Colegiatura", "DNI prescriptor", "Contraparte", "Registrado por"];

/** CSV con separador ";" y BOM, como lo abre Excel en configuración regional peruana. */
export function controlledCsv(rows: ControlledRow[]): string {
  const lines = rows.map((r) => [r.occurredAt, r.product, r.dci, r.list, r.lot, r.expiry, r.movement, r.quantity, r.balance, r.document, r.purchase, r.rxKind, r.rxDate, r.patient, r.prescriber, r.prescriberCmp, r.prescriberDoc, r.counterparty, r.recordedBy].map(csvCell).join(";"));
  return `﻿${[CONTROLLED_HEADER.join(";"), ...lines].join("\r\n")}\r\n`;
}
