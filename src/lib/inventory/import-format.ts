import JSZip from "jszip";
import { normalizeCode } from "@/lib/inventory/barcode";

/** Lectura y validación del archivo de carga masiva de productos. Sin acceso a datos: se prueba sola. */

export const MAX_IMPORT_ROWS = 2000;
export const MAX_IMPORT_BYTES = 2 * 1024 * 1024;
/** Tope de la hoja descomprimida: un .xlsx pequeño puede expandirse mucho (zip bomb) */
const MAX_SHEET_CHARS = 20_000_000;

export interface ImportRow {
  /** Número de fila en el archivo (la 1 es el encabezado) */
  line: number;
  sku: string;
  name?: string;
  salePrice?: string;
  barcode?: string;
  category?: string;
  dci?: string;
  therapeuticAction?: string;
  kind?: "GENERIC" | "BRAND";
  icbper?: boolean;
}

export interface ImportIssue { line: number; message: string }

export interface ParsedImport {
  rows: ImportRow[];
  errors: ImportIssue[];
  /** Encabezados que no se reconocen y se ignoran */
  ignoredColumns: string[];
}

type Field = Exclude<keyof ImportRow, "line">;

/** Minúsculas, sin tildes ni signos: "De Marca / Genérico" → "de marca generico". */
export const headerKey = (s: string): string =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

const HEADERS: Record<string, Field> = {
  sku: "sku", codigo: "sku", "codigo interno": "sku", "codigo sku": "sku",
  nombre: "name", producto: "name", descripcion: "name", "nombre del producto": "name",
  precio: "salePrice", "precio venta": "salePrice", "precio de venta": "salePrice", "precio unitario": "salePrice",
  "codigo de barras": "barcode", "codigo barras": "barcode", barras: "barcode", ean: "barcode",
  categoria: "category",
  "principio activo": "dci", dci: "dci",
  "accion terapeutica": "therapeuticAction",
  "de marca generico": "kind", "marca generico": "kind", "marca o generico": "kind", tipo: "kind",
  "indicador icbper": "icbper", icbper: "icbper", "bolsa plastica": "icbper",
};

/** Columnas de la plantilla, en orden. */
export const TEMPLATE_HEADERS = ["SKU", "Nombre", "Precio de venta", "Código de barras", "Categoría", "Principio Activo", "Acción Terapéutica", "De Marca / Genérico", "Indicador ICBPER"] as const;

// ── CSV ──────────────────────────────────────────────────────────────────────

/** CSV con comillas, "" escapado, saltos de línea dentro de comillas y separador `,` `;` o tabulador (se detecta en el encabezado). */
export function parseCsv(input: string): string[][] {
  const text = input.replace(/^﻿/, "");
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const count = (c: string) => firstLine.split(c).length - 1;
  const delimiter = count(";") >= count(",") && count(";") >= count("\t") && count(";") > 0 ? ";" : count("\t") > count(",") ? "\t" : ",";

  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += c;
    } else if (c === '"' && cell === "") quoted = true;
    else if (c === delimiter) { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += c;
  }
  if (cell !== "" || row.length > 0) { row.push(cell); rows.push(row); }
  return rows;
}

// ── Excel (.xlsx) ────────────────────────────────────────────────────────────

const unescapeXml = (s: string): string =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&");

/** "AB12" → índice de columna 27 (base 0) */
function columnIndex(ref: string): number {
  let n = 0;
  for (const ch of ref.replace(/[^A-Z]/gi, "").toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

const textOf = (xml: string): string => [...xml.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => unescapeXml(m[1]!)).join("");

/** Primera hoja del libro como matriz de textos. Solo .xlsx: un .xls (binario) no se lee. */
export async function readXlsx(buffer: ArrayBuffer | Uint8Array): Promise<string[][]> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch {
    throw new Error("El archivo no es un Excel (.xlsx) válido. Guárdelo como .xlsx o .csv.");
  }
  const read = async (path: string) => {
    const f = zip.file(path);
    if (!f) return null;
    const s = await f.async("string");
    if (s.length > MAX_SHEET_CHARS) throw new Error("La hoja es demasiado grande.");
    return s;
  };
  const workbook = await read("xl/workbook.xml");
  if (!workbook) throw new Error("El archivo no es un Excel (.xlsx) válido. Guárdelo como .xlsx o .csv.");

  // La primera hoja según el libro; si no se resuelve, la hoja 1
  const firstRid = /<sheet\b[^>]*r:id="([^"]+)"/.exec(workbook)?.[1];
  const rels = (await read("xl/_rels/workbook.xml.rels")) ?? "";
  let target = "worksheets/sheet1.xml";
  if (firstRid) {
    for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
      if (new RegExp(`Id="${firstRid}"`).test(m[0])) {
        const t = /Target="([^"]+)"/.exec(m[0])?.[1];
        if (t) target = t.replace(/^\/?(xl\/)?/, "");
      }
    }
  }
  const sheet = await read(`xl/${target}`);
  if (!sheet) throw new Error("No se encontró la hoja de datos en el archivo.");

  const shared = [...((await read("xl/sharedStrings.xml")) ?? "").matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1]!));
  const rows: string[][] = [];
  for (const r of sheet.matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const row: string[] = [];
    for (const c of (r[1] ?? "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = c[1]!, inner = c[2] ?? "";
      const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1];
      const type = /\bt="([^"]+)"/.exec(attrs)?.[1];
      const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
      let value = "";
      if (type === "s") value = shared[Number(v)] ?? "";
      else if (type === "inlineStr") value = textOf(inner);
      else if (type === "b") value = v === "1" ? "1" : "0";
      else if (v !== undefined) value = unescapeXml(v);
      const col = ref ? columnIndex(ref) : row.length;
      while (row.length < col) row.push("");
      row[col] = value;
    }
    rows.push(row);
  }
  return rows;
}

// ── Validación de filas ──────────────────────────────────────────────────────

const YES = new Set(["si", "s", "1", "x", "true", "verdadero", "yes", "y"]);
const NO = new Set(["no", "n", "0", "false", "falso"]);
const BRAND = new Set(["marca", "de marca", "brand", "comercial"]);
const GENERIC = new Set(["generico", "generic"]);

const norm = (s: string) => headerKey(s);
const SKU_RE = /^[A-Z0-9._-]{2,40}$/;

/** Convierte la matriz (con encabezado) en filas validadas. Una celda vacía significa «sin dato»: al actualizar no cambia el producto. */
export function parseImportRows(matrix: string[][]): ParsedImport {
  const errors: ImportIssue[] = [];
  const nonEmpty = matrix.map((cells, i) => ({ cells, line: i + 1 })).filter(({ cells }) => cells.some((c) => c.trim() !== ""));
  const head = nonEmpty[0];
  if (!head) return { rows: [], errors: [{ line: 1, message: "El archivo está vacío." }], ignoredColumns: [] };

  const columns = new Map<number, Field>();
  const ignored: string[] = [];
  head.cells.forEach((h, i) => {
    if (h.trim() === "") return;
    const field = HEADERS[headerKey(h)];
    if (field && ![...columns.values()].includes(field)) columns.set(i, field);
    else ignored.push(h.trim());
  });
  if (![...columns.values()].includes("sku")) {
    return { rows: [], errors: [{ line: head.line, message: "Falta la columna SKU: es la que identifica cada producto." }], ignoredColumns: ignored };
  }

  const body = nonEmpty.slice(1);
  if (body.length === 0) return { rows: [], errors: [{ line: head.line, message: "El archivo no tiene productos debajo del encabezado." }], ignoredColumns: ignored };
  if (body.length > MAX_IMPORT_ROWS) {
    return { rows: [], errors: [{ line: head.line, message: `El archivo tiene ${body.length} filas: el máximo es ${MAX_IMPORT_ROWS}. Divídalo en varios.` }], ignoredColumns: ignored };
  }

  const rows: ImportRow[] = [];
  const seenSku = new Map<string, number>();
  const seenBarcode = new Map<string, number>();

  for (const { cells, line } of body) {
    const raw: Partial<Record<Field, string>> = {};
    for (const [i, field] of columns) raw[field] = (cells[i] ?? "").trim();
    const fail = (message: string) => errors.push({ line, message });
    const start = errors.length;

    const sku = (raw.sku ?? "").toUpperCase();
    if (!SKU_RE.test(sku)) fail(`SKU «${raw.sku ?? ""}» inválido: use 2 a 40 letras, números, punto, guion o guion bajo.`);
    else if (seenSku.has(sku)) fail(`El SKU ${sku} está repetido (también en la fila ${seenSku.get(sku)}).`);
    else seenSku.set(sku, line);

    const row: ImportRow = { line, sku };
    const text = (field: "name" | "category" | "dci" | "therapeuticAction", label: string, max: number) => {
      const v = raw[field];
      if (!v) return;
      if (v.length > max) fail(`${label} supera los ${max} caracteres.`);
      else row[field] = v;
    };
    if (raw.name && raw.name.length < 2) fail("El nombre debe tener al menos 2 caracteres.");
    text("name", "El nombre", 160);
    text("category", "La categoría", 80);
    text("dci", "El principio activo", 120);
    text("therapeuticAction", "La acción terapéutica", 120);

    if (raw.salePrice) {
      const price = raw.salePrice.replace(/^S\/\.?\s*/i, "").replace(",", ".");
      if (!/^\d+(\.\d{1,4})?$/.test(price)) fail(`Precio «${raw.salePrice}» inválido: use un número, por ejemplo 12.50.`);
      else row.salePrice = price;
    }
    if (raw.barcode) {
      const code = normalizeCode(raw.barcode);
      if (!/^[A-Za-z0-9-]{4,48}$/.test(code)) fail(`Código de barras «${raw.barcode}» inválido.`);
      else if (seenBarcode.has(code)) fail(`El código de barras ${code} está repetido (también en la fila ${seenBarcode.get(code)}).`);
      else { row.barcode = code; seenBarcode.set(code, line); }
    }
    if (raw.kind) {
      const k = norm(raw.kind);
      if (BRAND.has(k)) row.kind = "BRAND";
      else if (GENERIC.has(k)) row.kind = "GENERIC";
      else fail(`«${raw.kind}» no es un tipo válido: escriba Marca o Genérico.`);
    }
    if (raw.icbper) {
      const k = norm(raw.icbper);
      if (YES.has(k)) row.icbper = true;
      else if (NO.has(k)) row.icbper = false;
      else fail(`«${raw.icbper}» no es válido para el indicador ICBPER: escriba Sí o No.`);
    }
    if (errors.length === start) rows.push(row);
  }
  return { rows, errors, ignoredColumns: ignored };
}

/** CSV de ejemplo para descargar: con BOM y `;` para que Excel lo abra bien en configuración regional peruana. */
export function templateCsv(): string {
  const example = ["PARA500", "Paracetamol 500 mg x 100 tab", "0.50", "7750000000011", "Analgésicos", "Paracetamol", "Analgésico, antipirético", "Genérico", "No"];
  const bag = ["BOLSA", "Bolsa plástica", "0.20", "", "Bolsas", "", "", "", "Sí"];
  return `﻿${[TEMPLATE_HEADERS as readonly string[], example, bag].map((r) => r.join(";")).join("\r\n")}\r\n`;
}
