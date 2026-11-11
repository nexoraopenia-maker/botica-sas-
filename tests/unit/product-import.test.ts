import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { MAX_IMPORT_ROWS, parseCsv, parseImportRows, readXlsx, templateCsv } from "@/lib/inventory/import-format";
import { categoryOptions, inCategory, NO_CATEGORY } from "@/lib/inventory/pos-categories";
import { permissionForPath } from "@/lib/modules/registry";

const head = ["SKU", "Nombre", "Precio de venta", "Código de barras", "Categoría", "Principio Activo", "Acción Terapéutica", "De Marca / Genérico", "Indicador ICBPER"];
const parse = (...rows: string[][]) => parseImportRows([head, ...rows]);

describe("lectura de CSV", () => {
  it("separa por ; , o tabulador según el encabezado", () => {
    expect(parseCsv("a;b;c\n1;2;3")).toEqual([["a", "b", "c"], ["1", "2", "3"]]);
    expect(parseCsv("a,b,c\n1,2,3")).toEqual([["a", "b", "c"], ["1", "2", "3"]]);
    expect(parseCsv("a\tb\n1\t2")).toEqual([["a", "b"], ["1", "2"]]);
  });
  it("respeta comillas, comillas escapadas, separadores y saltos de línea dentro de una celda", () => {
    expect(parseCsv('a;b\r\n"x;y";"di ""hola"""\r\n"l1\nl2";z')).toEqual([["a", "b"], ["x;y", 'di "hola"'], ["l1\nl2", "z"]]);
  });
  it("quita el BOM y tolera el último renglón sin salto", () => {
    expect(parseCsv("﻿SKU;Nombre\nA1;Uno")).toEqual([["SKU", "Nombre"], ["A1", "Uno"]]);
  });
});

describe("lectura de Excel (.xlsx)", () => {
  async function book(sheet: string, shared = "") {
    const zip = new JSZip();
    zip.file("[Content_Types].xml", "<Types/>");
    zip.file("xl/workbook.xml", '<workbook><sheets><sheet name="Datos" sheetId="1" r:id="rId7"/></sheets></workbook>');
    zip.file("xl/_rels/workbook.xml.rels", '<Relationships><Relationship Id="rId7" Type="x" Target="worksheets/sheet3.xml"/></Relationships>');
    if (shared) zip.file("xl/sharedStrings.xml", shared);
    zip.file("xl/worksheets/sheet3.xml", `<worksheet><sheetData>${sheet}</sheetData></worksheet>`);
    return zip.generateAsync({ type: "uint8array" });
  }
  it("lee textos compartidos, en línea, números, booleanos y celdas vacías intermedias", async () => {
    const sheet = '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row>'
      + '<row r="2"><c r="A2" t="inlineStr"><is><t>PARA &amp; CO</t></is></c><c r="B2"><v>12.5</v></c><c r="C2" t="b"><v>1</v></c><c r="D2"/></row>';
    const shared = '<sst><si><t>SKU</t></si><si><r><t>Pre</t></r><r><t>cio</t></r></si></sst>';
    expect(await readXlsx(await book(sheet, shared))).toEqual([["SKU", "", "Precio"], ["PARA & CO", "12.5", "1", ""]]);
  });
  it("rechaza un archivo que no es un .xlsx", async () => {
    await expect(readXlsx(new TextEncoder().encode("esto no es un zip"))).rejects.toThrow(/Excel/);
    const zip = new JSZip(); zip.file("otra-cosa.txt", "x");
    await expect(readXlsx(await zip.generateAsync({ type: "uint8array" }))).rejects.toThrow(/Excel/);
  });
});

describe("validación de filas", () => {
  it("reconoce los encabezados con tildes, mayúsculas y alias", () => {
    const r = parseImportRows([["sku", "PRODUCTO", "Precio", "categoria", "dci", "ACCIÓN TERAPÉUTICA", "marca/generico", "ICBPER", "Otra"], ["a1", "Uno", "1", "Cat", "Paracetamol", "Analgésico", "Marca", "si", "x"]]);
    expect(r.errors).toEqual([]);
    expect(r.ignoredColumns).toEqual(["Otra"]);
    expect(r.rows[0]).toEqual({ line: 2, sku: "A1", name: "Uno", salePrice: "1", category: "Cat", dci: "Paracetamol", therapeuticAction: "Analgésico", kind: "BRAND", icbper: true });
  });
  it("las celdas vacías quedan sin dato, no como falso ni como texto vacío", () => {
    const [row] = parse(["A1", "", "", "", "Cat", "", "", "", ""]).rows;
    expect(row).toEqual({ line: 2, sku: "A1", category: "Cat" });
    expect("icbper" in row!).toBe(false);
  });
  it("entiende marca y genérico, sí y no en sus variantes", () => {
    const kinds = ["Marca", "de marca", "MARCA", "Genérico", "generico", "GENERIC"].map((k) => parse(["A1", "", "", "", "", "", "", k, ""]).rows[0]!.kind);
    expect(kinds).toEqual(["BRAND", "BRAND", "BRAND", "GENERIC", "GENERIC", "GENERIC"]);
    const flags = ["Sí", "SI", "1", "x", "No", "0", "falso"].map((v) => parse(["A1", "", "", "", "", "", "", "", v]).rows[0]!.icbper);
    expect(flags).toEqual([true, true, true, true, false, false, false]);
  });
  it("acepta precios con coma decimal y con S/", () => {
    expect(parse(["A1", "", "12,50", "", "", "", "", "", ""]).rows[0]!.salePrice).toBe("12.50");
    expect(parse(["A2", "", "S/ 3.5", "", "", "", "", "", ""]).rows[0]!.salePrice).toBe("3.5");
  });
  it("reporta cada error con su número de fila y no deja pasar la fila mala", () => {
    const r = parse(
      ["A1", "Uno", "abc", "", "", "", "", "", ""],
      ["B 2", "Dos", "1", "", "", "", "", "", ""],
      ["C3", "Tres", "1", "", "", "", "", "Otro", ""],
      ["D4", "Cuatro", "1", "", "", "", "", "", "quizás"],
      ["E5", "Cinco", "1", "", "x".repeat(81), "", "", "", ""],
      ["F6", "Seis", "1", "ab", "", "", "", "", ""],
      ["OK7", "Siete", "1", "", "", "", "", "", ""],
    );
    expect(r.errors.map((e) => e.line)).toEqual([2, 3, 4, 5, 6, 7]);
    expect(r.errors[0]!.message).toMatch(/Precio/);
    expect(r.errors[1]!.message).toMatch(/SKU/);
    expect(r.errors[2]!.message).toMatch(/Marca o Genérico/);
    expect(r.errors[3]!.message).toMatch(/Sí o No/);
    expect(r.errors[4]!.message).toMatch(/categoría supera/);
    expect(r.errors[5]!.message).toMatch(/Código de barras/);
    expect(r.rows.map((x) => x.sku)).toEqual(["OK7"]);
  });
  it("detecta SKU y código de barras repetidos dentro del archivo", () => {
    const r = parse(["A1", "Uno", "1", "11112222", "", "", "", "", ""], ["a1", "Dos", "1", "", "", "", "", "", ""], ["B2", "Tres", "1", "11112222", "", "", "", "", ""]);
    expect(r.errors).toEqual([
      { line: 3, message: expect.stringContaining("SKU A1 está repetido (también en la fila 2)") },
      { line: 4, message: expect.stringContaining("código de barras 11112222 está repetido (también en la fila 2)") },
    ]);
  });
  it("exige la columna SKU y un archivo con datos", () => {
    expect(parseImportRows([["Nombre", "Precio"], ["x", "1"]]).errors[0]!.message).toMatch(/columna SKU/);
    expect(parseImportRows([]).errors[0]!.message).toMatch(/vacío/);
    expect(parseImportRows([head]).errors[0]!.message).toMatch(/debajo del encabezado/);
    expect(parseImportRows([head, ["", "", "", "", "", "", "", "", ""]]).errors[0]!.message).toMatch(/debajo del encabezado/);
  });
  it("salta renglones vacíos pero conserva el número de fila real", () => {
    const r = parseImportRows([head, ["", "", "", "", "", "", "", "", ""], ["A1", "Uno", "1", "", "", "", "", "", ""]]);
    expect(r.rows[0]!.line).toBe(3);
  });
  it("limita las filas por archivo", () => {
    const many = Array.from({ length: MAX_IMPORT_ROWS + 1 }, (_, i) => [`S${i}`, "x", "1", "", "", "", "", "", ""]);
    expect(parseImportRows([head, ...many]).errors[0]!.message).toContain(String(MAX_IMPORT_ROWS));
  });
  it("la plantilla que se descarga es válida tal cual", () => {
    const r = parseImportRows(parseCsv(templateCsv()));
    expect(r.errors).toEqual([]);
    expect(r.ignoredColumns).toEqual([]);
    expect(r.rows).toHaveLength(2);
    expect(r.rows[1]).toMatchObject({ sku: "BOLSA", icbper: true });
  });
});

describe("filtro por categoría de la caja", () => {
  const p = (id: string | null, name: string | null) => ({ categoryId: id, categoryName: name });
  const catalog = [p("1", "Vitaminas"), p("2", "Analgésicos"), p("2", "Analgésicos"), p(null, null)];
  it("cuenta por categoría, ordena por nombre y cuenta los sin categoría", () => {
    expect(categoryOptions(catalog)).toEqual({ options: [{ id: "2", name: "Analgésicos", count: 2 }, { id: "1", name: "Vitaminas", count: 1 }], uncategorized: 1 });
    expect(categoryOptions([])).toEqual({ options: [], uncategorized: 0 });
  });
  it("filtra por una categoría, por «sin categoría» o deja todo", () => {
    expect(catalog.filter((x) => inCategory(x, "2"))).toHaveLength(2);
    expect(catalog.filter((x) => inCategory(x, NO_CATEGORY))).toEqual([p(null, null)]);
    expect(catalog.filter((x) => inCategory(x, null))).toHaveLength(4);
  });
});

describe("permiso de la carga masiva", () => {
  it("exige gestionar productos, no solo ver inventario", () => {
    expect(permissionForPath("/app/inventory/import")).toBe("products.manage");
    expect(permissionForPath("/app/inventory/import/plantilla")).toBe("products.manage");
    expect(permissionForPath("/app/inventory")).toBe("inventory.read");
  });
});
