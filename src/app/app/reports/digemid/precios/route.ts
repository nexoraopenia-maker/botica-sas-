import { NextResponse } from "next/server";
import { requireTenant } from "@/lib/auth/session";
import { DomainError } from "@/lib/result";
import { observatoryRows } from "@/lib/reports/digemid";
import { observatoryXlsx } from "@/lib/reports/digemid-format";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const branch = new URL(req.url).searchParams.get("branch") ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(branch)) return NextResponse.json({ error: "Sucursal inválida" }, { status: 400 });
  try {
    const ctx = await requireTenant({ permission: "pharmacy.controlled_log", module: "PHARMACY", branchId: branch });
    const rows = await observatoryRows({ tenantId: ctx.tenantId, userId: ctx.userId }, branch);
    return new Response(new Uint8Array(await observatoryXlsx(rows)), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="observatorio-precios-${rows[0]?.establishment ?? "sin-codigo"}.xlsx"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    if (err instanceof DomainError) {
      const denied = ["FORBIDDEN", "FORBIDDEN_BRANCH", "NO_TENANT", "MODULE_DISABLED"].includes(err.code);
      return NextResponse.json({ error: err.message }, { status: denied ? 403 : err.code === "UNAUTHENTICATED" ? 401 : 422 });
    }
    throw err;
  }
}
