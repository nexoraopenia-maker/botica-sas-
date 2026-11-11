import { NextResponse } from "next/server";
import { requireTenant } from "@/lib/auth/session";
import { DomainError } from "@/lib/result";
import { templateCsv } from "@/lib/inventory/import-format";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Plantilla de la carga masiva: encabezados y dos filas de ejemplo. */
export async function GET(): Promise<Response> {
  try {
    await requireTenant({ permission: "products.manage" });
    return new Response(templateCsv(), {
      headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="plantilla-productos.csv"', "Cache-Control": "no-store" },
    });
  } catch (err) {
    if (err instanceof DomainError) {
      const denied = ["FORBIDDEN", "NO_TENANT"].includes(err.code);
      return NextResponse.json({ error: err.message }, { status: denied ? 403 : err.code === "UNAUTHENTICATED" ? 401 : 422 });
    }
    throw err;
  }
}
