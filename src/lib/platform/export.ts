import "server-only";
import { createHash } from "node:crypto";
import JSZip from "jszip";
import { platformDb } from "@/lib/db";
import { putObject, tenantPath } from "@/lib/storage";
import { addDays } from "@/lib/time";
import type { HandlerResult } from "@/lib/sunat/emit";

/** Tablas exportadas (lista blanca: los nombres se interpolan en SQL). Secretos excluidos. */
const EXPORT_TABLES = [
  "tenants", "branches", "tenant_users", "roles", "customers", "suppliers", "product_categories", "products",
  "product_batches", "stock_movements", "purchases", "purchase_items", "document_series", "documents",
  "document_items", "document_item_lots", "document_payments", "sunat_submissions", "owners", "pets",
  "medical_records", "pet_vaccinations", "pharmacist_staff", "prescriptions", "controlled_substance_log", "audit_logs",
] as const;

/** Exportación completa previa a la eliminación: NDJSON por tabla + índice de XML/CDR en Storage. */
export async function runTenantExport(exportId: string): Promise<HandlerResult> {
  const db = platformDb();
  const exp = await db.tenantExport.findUnique({ where: { id: exportId } });
  if (!exp) return { status: "dead", error: "Export inexistente" };
  if (exp.status === "READY") return { status: "done" };
  await db.tenantExport.update({ where: { id: exportId }, data: { status: "RUNNING" } });

  const zip = new JSZip();
  for (const table of EXPORT_TABLES) {
    const key = table === "tenants" ? "id" : "tenant_id";
    const rows = await db.$queryRawUnsafe<{ j: unknown }[]>(
      `SELECT row_to_json(t) AS j FROM public.${table} t WHERE t.${key} = $1::uuid`,
      exp.tenant_id,
    );
    zip.file(`${table}.ndjson`, rows.map((r) => JSON.stringify(r.j)).join("\n"));
  }
  const files = await db.document.findMany({
    where: { tenant_id: exp.tenant_id },
    select: { series: true, number: true, doc_type: true, xml_path: true, cdr_path: true },
  });
  zip.file("sunat_files_index.json", JSON.stringify(files));
  zip.file("README.txt", "Exportación completa. Los XML firmados y CDR están en el bucket 'sunat' según sunat_files_index.json.\n");

  const buf = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  const path = tenantPath(exp.tenant_id, "exports", `${exportId}.zip`);
  await putObject("tenant-files", path, buf, "application/zip");
  await db.tenantExport.update({
    where: { id: exportId },
    data: {
      status: "READY", storage_path: path, sha256: createHash("sha256").update(buf).digest("hex"),
      completed_at: new Date(), expires_at: addDays(new Date(), 90),
    },
  });
  return { status: "done" };
}
