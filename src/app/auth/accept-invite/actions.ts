"use server";

import { cookies } from "next/headers";
import { platformDb } from "@/lib/db";
import { ACTIVE_TENANT_COOKIE, requireIdentity } from "@/lib/auth/session";
import { ok, toActionError, type ActionResult } from "@/lib/result";

/** Tras fijar su contraseña, el usuario invitado activa sus membresías pendientes. */
export async function acceptInviteAction(): Promise<ActionResult<{ tenantId: string | null }>> {
  try {
    const identity = await requireIdentity();
    const db = platformDb();
    const pending = await db.tenantUser.findMany({
      where: { user_id: identity.userId, status: "INVITED", deleted_at: null },
      orderBy: { created_at: "asc" },
    });
    if (pending.length) {
      await db.tenantUser.updateMany({
        where: { id: { in: pending.map((p) => p.id) } },
        data: { status: "ACTIVE", accepted_at: new Date() },
      });
      (await cookies()).set(ACTIVE_TENANT_COOKIE, pending[0]!.tenant_id, { httpOnly: true, secure: true, sameSite: "lax", path: "/" });
    }
    return ok({ tenantId: pending[0]?.tenant_id ?? null });
  } catch (e) {
    return toActionError(e);
  }
}
