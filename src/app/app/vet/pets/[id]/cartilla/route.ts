import { NextResponse } from "next/server";
import { requireTenant } from "@/lib/auth/session";
import { env } from "@/lib/env";
import { DomainError } from "@/lib/result";
import { cartillaToken, loadCartilla, renderCartillaPdf } from "@/lib/vet/cartilla";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Descarga la cartilla en PDF. Solo pacientes del negocio de la sesión. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  try {
    const ctx = await requireTenant({ permission: "vet.records", module: "VETERINARY" });
    if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "Paciente no encontrado" }, { status: 404 });
    const data = await loadCartilla(id, ctx.tenantId);
    if (!data) return NextResponse.json({ error: "Paciente no encontrado" }, { status: 404 });
    const url = `${env().NEXT_PUBLIC_APP_URL.replace(/\/$/, "")}/cartilla/${cartillaToken(id)}`;
    const pdf = await renderCartillaPdf(data, url);
    const name = data.pet.name.normalize("NFD").replace(/[^a-zA-Z0-9]+/g, "-");
    return new Response(new Uint8Array(pdf), {
      headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="cartilla-${name}.pdf"`, "Cache-Control": "no-store" },
    });
  } catch (err) {
    if (err instanceof DomainError) return NextResponse.json({ error: err.message }, { status: err.code === "UNAUTHENTICATED" ? 401 : 403 });
    throw err;
  }
}
