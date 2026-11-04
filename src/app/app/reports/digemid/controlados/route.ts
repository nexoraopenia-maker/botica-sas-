import { NextResponse } from "next/server";
import { requireTenant } from "@/lib/auth/session";
import { DomainError } from "@/lib/result";
import { loadControlledReport } from "@/lib/reports/digemid";
import { controlledCsv } from "@/lib/reports/digemid-format";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Exporta el libro con datos de pacientes: exige el permiso del libro de controlados y queda auditado. */
export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const from = url.searchParams.get("desde") ?? "", to = url.searchParams.get("hasta") ?? "";
  if (!DATE.test(from) || !DATE.test(to) || from > to) return NextResponse.json({ error: "Periodo inválido" }, { status: 400 });
  try {
    const ctx = await requireTenant({ permission: "pharmacy.controlled_log", module: "PHARMACY" });
    const rows = await loadControlledReport({ tenantId: ctx.tenantId, userId: ctx.userId }, from, to, { audited: true });
    return new Response(controlledCsv(rows), {
      headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="controlados-${from}-${to}.csv"`, "Cache-Control": "no-store" },
    });
  } catch (err) {
    if (err instanceof DomainError) {
      const denied = ["FORBIDDEN", "NO_TENANT", "MODULE_DISABLED"].includes(err.code);
      return NextResponse.json({ error: err.message }, { status: denied ? 403 : err.code === "UNAUTHENTICATED" ? 401 : 422 });
    }
    throw err;
  }
}
