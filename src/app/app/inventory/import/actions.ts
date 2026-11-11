"use server";

import { revalidatePath } from "next/cache";
import { requireTenant } from "@/lib/auth/session";
import { importProducts, type ImportSummary } from "@/lib/inventory/import";
import { MAX_IMPORT_BYTES, parseCsv, parseImportRows, readXlsx } from "@/lib/inventory/import-format";
import { DomainError, ok, toActionError, type ActionResult } from "@/lib/result";

export type ImportResult = ImportSummary & { ignoredColumns: string[] };

/** UTF-8; si el CSV viene en ANSI (Excel en Windows), Windows-1252 para no corromper las tildes. */
function decode(bytes: ArrayBuffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

/** `mode`: "preview" solo calcula el efecto; "apply" lo aplica (todo o nada). El archivo se envía en ambos: no hay estado en el servidor. */
export async function importProductsAction(form: FormData): Promise<ActionResult<ImportResult>> {
  try {
    const ctx = await requireTenant({ permission: "products.manage", mutation: true });
    const file = form.get("file");
    const apply = form.get("mode") === "apply";
    if (!(file instanceof File) || file.size === 0) throw new DomainError("VALIDATION", "Seleccione un archivo .csv o .xlsx.");
    if (file.size > MAX_IMPORT_BYTES) throw new DomainError("VALIDATION", "El archivo supera los 2 MB. Divídalo en varios.");

    const name = file.name.toLowerCase();
    const bytes = await file.arrayBuffer();
    let matrix: string[][];
    if (name.endsWith(".xlsx")) {
      try { matrix = await readXlsx(bytes); } catch (e) { throw new DomainError("VALIDATION", e instanceof Error ? e.message : "No se pudo leer el Excel."); }
    } else if (name.endsWith(".csv") || name.endsWith(".txt")) matrix = parseCsv(decode(bytes));
    else if (name.endsWith(".xls")) throw new DomainError("VALIDATION", "Los archivos .xls (Excel antiguo) no se pueden leer. Guárdelo como .xlsx o .csv.");
    else throw new DomainError("VALIDATION", "Formato no admitido: use .csv o .xlsx.");

    const parsed = parseImportRows(matrix);
    const empty = { creates: 0, updates: 0, unchanged: 0, newCategories: [], changes: [], notes: [], applied: false, ignoredColumns: parsed.ignoredColumns };
    if (parsed.errors.length > 0) return ok({ ...empty, errors: parsed.errors });

    const summary = await importProducts({ tenantId: ctx.tenantId, userId: ctx.userId }, parsed.rows, { modules: ctx.modules }, { apply });
    if (summary.applied) {
      revalidatePath("/app/inventory");
      revalidatePath("/app/pos");
    }
    return ok({ ...summary, ignoredColumns: parsed.ignoredColumns });
  } catch (e) {
    return toActionError(e);
  }
}
