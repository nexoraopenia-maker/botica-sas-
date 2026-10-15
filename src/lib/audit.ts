import "server-only";
import { headers } from "next/headers";
import type { Prisma } from "@/generated/prisma/client";
import type { Tx } from "@/lib/db";

export interface AuditEntry {
  tenantId: string | null;
  actorUserId: string | null;
  actorKind: "tenant_user" | "platform_admin" | "system" | "impersonator";
  impersonationId?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  before?: Prisma.InputJsonValue | null;
  after?: Prisma.InputJsonValue | null;
  reason?: string | null;
}

/** Campos que jamás se escriben en auditoría. */
const REDACT = new Set(["sol_password", "password", "pfx", "pfx_password", "ciphertext", "wrapped_dek", "token"]);

function redact(v: Prisma.InputJsonValue | null | undefined): Prisma.InputJsonValue | undefined {
  if (v === null || v === undefined) return undefined;
  if (Array.isArray(v)) return v.map((x) => redact(x as Prisma.InputJsonValue) ?? null) as Prisma.InputJsonValue;
  if (typeof v === "object") {
    const out: Record<string, Prisma.InputJsonValue | null> = {};
    for (const [k, val] of Object.entries(v)) {
      out[k] = REDACT.has(k) ? "[REDACTED]" : (redact(val as Prisma.InputJsonValue) ?? null);
    }
    return out as Prisma.InputJsonValue;
  }
  return v;
}

async function requestMeta(): Promise<{ ip: string | null; userAgent: string | null; requestId: string | null }> {
  try {
    const h = await headers();
    return {
      ip: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? h.get("x-real-ip"),
      userAgent: h.get("user-agent"),
      requestId: h.get("x-request-id"),
    };
  } catch {
    return { ip: null, userAgent: null, requestId: null }; // fuera de un request (workers)
  }
}

/** Inserta en audit_logs dentro de la MISMA transacción que la acción auditada. */
export async function audit(tx: Tx, e: AuditEntry): Promise<void> {
  const meta = await requestMeta();
  await tx.auditLog.create({
    data: {
      tenant_id: e.tenantId,
      actor_user_id: e.actorUserId,
      actor_kind: e.actorKind,
      impersonation_id: e.impersonationId ?? null,
      action: e.action,
      entity_type: e.entityType,
      entity_id: e.entityId ?? null,
      before: redact(e.before),
      after: redact(e.after),
      reason: e.reason ?? null,
      ip: meta.ip,
      user_agent: meta.userAgent,
      request_id: meta.requestId,
      hash: "", // lo calcula el trigger app.audit_chain
    },
  });
}
