import "server-only";
import { cookies } from "next/headers";
import { platformDb } from "@/lib/db";
import { audit } from "@/lib/audit";
import { DomainError } from "@/lib/result";
import { IMPERSONATION_COOKIE, type PlatformAdminContext } from "@/lib/auth/session";
import { impersonationSchema } from "@/lib/platform/schemas";
import type { z } from "zod";

/**
 * Impersonación de soporte: motivo obligatorio, TTL ≤ 60 min (CHECK en BD),
 * solo lectura por defecto, auditada en el log del TENANT (el cliente la ve).
 */
export async function startImpersonation(admin: PlatformAdminContext, raw: z.input<typeof impersonationSchema>): Promise<{ id: string; expiresAt: Date }> {
  const i = impersonationSchema.parse(raw);
  if (!i.readOnly && admin.role !== "OWNER") {
    throw new DomainError("FORBIDDEN", "Solo el propietario puede impersonar con permisos de escritura.");
  }
  const db = platformDb();
  const tenant = await db.tenant.findUniqueOrThrow({ where: { id: i.tenantId } });
  if (tenant.status === "DELETED") throw new DomainError("INVALID_STATE", "Cliente eliminado.");

  const startedAt = new Date();
  const expiresAt = new Date(startedAt.getTime() + i.minutes * 60_000);
  const session = await db.$transaction(async (tx) => {
    await tx.impersonationSession.updateMany({
      where: { platform_admin_id: admin.userId, ended_at: null },
      data: { ended_at: startedAt },
    });
    const s = await tx.impersonationSession.create({
      data: {
        platform_admin_id: admin.userId, tenant_id: i.tenantId, reason: i.reason, ticket_ref: i.ticketRef ?? null,
        read_only: i.readOnly, started_at: startedAt, expires_at: expiresAt,
      },
    });
    await audit(tx, {
      tenantId: i.tenantId, actorUserId: admin.userId, actorKind: "platform_admin", impersonationId: s.id,
      action: "impersonation.start", entityType: "tenant", entityId: i.tenantId, reason: i.reason,
      after: { readOnly: i.readOnly, minutes: i.minutes, ticket: i.ticketRef ?? null },
    });
    return s;
  });

  (await cookies()).set(IMPERSONATION_COOKIE, session.id, {
    httpOnly: true, secure: true, sameSite: "strict", path: "/", expires: expiresAt,
  });
  return { id: session.id, expiresAt };
}

export async function endImpersonation(admin: PlatformAdminContext): Promise<void> {
  const jar = await cookies();
  const id = jar.get(IMPERSONATION_COOKIE)?.value;
  jar.delete(IMPERSONATION_COOKIE);
  if (!id) return;
  const db = platformDb();
  await db.$transaction(async (tx) => {
    const s = await tx.impersonationSession.findFirst({ where: { id, platform_admin_id: admin.userId, ended_at: null } });
    if (!s) return;
    await tx.impersonationSession.update({ where: { id }, data: { ended_at: new Date() } });
    await audit(tx, {
      tenantId: s.tenant_id, actorUserId: admin.userId, actorKind: "platform_admin", impersonationId: id,
      action: "impersonation.end", entityType: "tenant", entityId: s.tenant_id,
    });
  });
}
