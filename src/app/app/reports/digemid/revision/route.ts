import { NextResponse } from "next/server";
import { requireTenant } from "@/lib/auth/session";
import { DomainError } from "@/lib/result";
import { loadPriceStockRows } from "@/lib/reports/digemid";
import { priceStockCsv } from "@/lib/reports/digemid-format";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** CSV de revisión: código, precio y stock actual de la sucursal, para cotejar antes de cargar al Observatorio. */
export async function GET(req: Request): Promise<Response> {
  const branch = new URL(req.url).searchParams.get("branch") ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(branch)) return NextResponse.json({ error: "Sucursal inválida" }, { status: 400 });
  try {
    const ctx = await requireTenant({ permission: "pharmacy.controlled_log", module: "PHARMACY", branchId: branch });
    const rows = await loadPriceStockRows({ tenantId: ctx.tenantId, userId: ctx.userId }, branch);
    return new Response(priceStockCsv(rows), {
      headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="precios-y-stock.csv"', "Cache-Control": "no-store" },
    });
  } catch (err) {
    if (err instanceof DomainError) {
      const denied = ["FORBIDDEN", "FORBIDDEN_BRANCH", "NO_TENANT", "MODULE_DISABLED"].includes(err.code);
      return NextResponse.json({ error: err.message }, { status: denied ? 403 : err.code === "UNAUTHENTICATED" ? 401 : 422 });
    }
    throw err;
  }
}
