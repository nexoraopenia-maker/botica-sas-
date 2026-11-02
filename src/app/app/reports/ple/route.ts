import { NextResponse } from "next/server";
import { requireTenant } from "@/lib/auth/session";
import { platformDb } from "@/lib/db";
import { DomainError } from "@/lib/result";
import { buildPleFile } from "@/lib/reports/ple";
import type { PleBook } from "@/lib/reports/ple-format";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Descarga del PLE. Exige reports.accounting: un cajero recibe 403 aunque conozca la URL. */
export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const book = url.searchParams.get("book");
  const period = url.searchParams.get("period") ?? "";
  if (book !== "sales" && book !== "purchases") return NextResponse.json({ error: "Libro inválido" }, { status: 400 });
  try {
    const ctx = await requireTenant({ permission: "reports.accounting" });
    const tenant = await platformDb().tenant.findUniqueOrThrow({ where: { id: ctx.tenantId }, select: { ruc: true } });
    const file = await buildPleFile({ tenantId: ctx.tenantId, userId: ctx.userId }, tenant, book as PleBook, period);
    return new Response(new Uint8Array(file.content), {
      headers: {
        "Content-Type": "text/plain; charset=windows-1252",
        "Content-Disposition": `attachment; filename="${file.fileName}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    if (err instanceof DomainError) {
      const forbidden = err.code === "FORBIDDEN" || err.code === "NO_TENANT";
      return NextResponse.json({ error: err.message }, { status: forbidden ? 403 : err.code === "UNAUTHENTICATED" ? 401 : 422 });
    }
    throw err;
  }
}
