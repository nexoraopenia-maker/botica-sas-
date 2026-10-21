import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { ModuleKey } from "@/generated/prisma/enums";
import { describeDbError, platformDb } from "@/lib/db";
import { supabaseServer } from "@/lib/supabase/server";
import { DomainError } from "@/lib/result";
import { hasPermission, type Permission } from "@/lib/auth/permissions";

export const ACTIVE_TENANT_COOKIE = "nx_tenant";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const asUuid = (v: string | undefined): string | undefined => (v && UUID_RE.test(v) ? v : undefined);
export const IMPERSONATION_COOKIE = "nx_imp";

interface AmrEntry {
  method: string;
  timestamp: number;
}

export interface AuthIdentity {
  userId: string;
  email: string;
  aal: "aal1" | "aal2";
  /** Momento (epoch s) de la última autenticación (cualquier factor) */
  lastAuthAt: number;
}

export interface TenantContext {
  tenantId: string;
  userId: string;
  branchIds: string[];
  roleKey: string;
  permissions: string[];
  modules: Set<ModuleKey>;
  impersonation: { id: string; readOnly: boolean; expiresAt: Date } | null;
}

/** Identidad verificada (firma del JWT validada por getClaims). */
export const getIdentity = cache(async (): Promise<AuthIdentity | null> => {
  const supabase = await supabaseServer();
  const { data, error } = await supabase.auth.getClaims();
  if (error || !data?.claims?.sub) return null;
  const c = data.claims;
  const amr = (Array.isArray(c.amr) ? c.amr : []).filter(
    (e): e is AmrEntry => typeof e === "object" && e !== null && "timestamp" in e,
  );
  return {
    userId: c.sub,
    email: typeof c.email === "string" ? c.email : "",
    aal: c.aal === "aal2" ? "aal2" : "aal1",
    lastAuthAt: amr.reduce((m, e) => Math.max(m, e.timestamp), 0),
  };
});

export async function requireIdentity(): Promise<AuthIdentity> {
  const id = await getIdentity();
  if (!id) throw new DomainError("UNAUTHENTICATED", "Sesión expirada. Inicie sesión nuevamente.");
  return id;
}

/**
 * Resuelve el contexto de tenant: membresía activa + módulos + permisos.
 * Si hay una sesión de impersonación válida del superadmin, se usa esa.
 * Se consulta con platformDb porque aún no hay contexto RLS; todas las
 * condiciones de membresía se verifican explícitamente aquí.
 */
export const getTenantContext = cache(async (): Promise<TenantContext | null> => {
  const identity = await getIdentity();
  if (!identity) return null;
  const jar = await cookies();
  const db = platformDb();

  // Sesión de soporte (impersonación). Nunca debe tumbar la página: cookie inválida, sesión vencida o
  // un error de BD se registran y se continúa como usuario normal (requireTenant decide qué mostrar).
  const impId = asUuid(jar.get(IMPERSONATION_COOKIE)?.value);
  if (impId) {
    try {
      const imp = await db.impersonationSession.findFirst({
        where: { id: impId, platform_admin_id: identity.userId, ended_at: null, expires_at: { gt: new Date() } },
        select: { id: true, tenant_id: true, read_only: true, expires_at: true },
      });
      if (imp && identity.aal !== "aal2") {
        console.warn("[soporte] sesión de soporte ignorada: la sesión del superadmin no está verificada con MFA (aal2)");
      } else if (imp) {
        const modules = await db.tenantModule.findMany({ where: { tenant_id: imp.tenant_id, enabled: true }, select: { module: true } });
        return {
          tenantId: imp.tenant_id,
          userId: identity.userId,
          branchIds: [],
          roleKey: "impersonator",
          permissions: imp.read_only ? ["documents.read", "inventory.read", "reports.read", "audit.read"] : ["*"],
          modules: new Set(modules.map((m) => m.module)),
          impersonation: { id: imp.id, readOnly: imp.read_only, expiresAt: imp.expires_at },
        };
      }
    } catch (err) {
      const e = err as { code?: string; message?: string };
      console.error("[soporte] no se pudo leer la sesión de soporte", { code: e.code, message: e.message?.slice(0, 300) });
    }
  }

  const requested = asUuid(jar.get(ACTIVE_TENANT_COOKIE)?.value);
  let membership;
  try {
    membership = await db.tenantUser.findFirst({
      where: {
        user_id: identity.userId,
        status: "ACTIVE",
        deleted_at: null,
        ...(requested ? { tenant_id: requested } : {}),
        tenant: { status: { in: ["TRIAL", "ACTIVE"] }, deleted_at: null },
      },
      include: { role: true, tenant: { include: { modules: { where: { enabled: true } } } } },
      orderBy: { created_at: "asc" },
    });
  } catch (err) {
    // Deja en los logs la causa real (p. ej. "max clients reached" del pooler) en lugar de solo "Invalid invocation"
    console.error("[tenant] no se pudo resolver el negocio del usuario", describeDbError(err));
    throw err;
  }
  if (!membership) return null;

  return {
    tenantId: membership.tenant_id,
    userId: identity.userId,
    branchIds: membership.branch_ids,
    roleKey: membership.role.key,
    permissions: membership.role.permissions,
    modules: new Set(membership.tenant.modules.map((m) => m.module)),
    impersonation: null,
  };
});

export interface RequireTenantOptions {
  permission?: Permission;
  module?: ModuleKey;
  /** Acciones que modifican datos: prohibidas en impersonación de solo lectura */
  mutation?: boolean;
  branchId?: string;
}

/** Guard central para Server Actions, Route Handlers y Server Components. */
export async function requireTenant(opts: RequireTenantOptions = {}): Promise<TenantContext> {
  const ctx = await getTenantContext();
  if (!ctx) {
    // Un superadmin sin sesión de soporte válida no es "un usuario sin negocio": vuelve a su panel con el motivo.
    const identity = await getIdentity();
    if (identity && (await platformDb().platformAdmin.findFirst({ where: { id: identity.userId, deleted_at: null }, select: { id: true } }))) {
      const hadSupportCookie = !!(await cookies()).get(IMPERSONATION_COOKIE)?.value;
      redirect(`/superadmin?soporte=${hadSupportCookie ? "expirado" : "requerido"}`);
    }
    throw new DomainError("NO_TENANT", "No tiene acceso a ningún negocio activo.");
  }
  if (opts.module && !ctx.modules.has(opts.module)) {
    throw new DomainError("MODULE_DISABLED", `El módulo ${opts.module} no está activo para su negocio.`);
  }
  if (opts.permission && !hasPermission(ctx.permissions, opts.permission)) {
    throw new DomainError("FORBIDDEN", "No tiene permiso para esta acción.");
  }
  if (opts.mutation && ctx.impersonation?.readOnly) {
    throw new DomainError("READ_ONLY_IMPERSONATION", "Sesión de soporte en modo solo lectura.");
  }
  if (opts.branchId && ctx.branchIds.length > 0 && !ctx.branchIds.includes(opts.branchId)) {
    throw new DomainError("FORBIDDEN_BRANCH", "No tiene acceso a esta sucursal.");
  }
  return ctx;
}

export interface PlatformAdminContext {
  userId: string;
  email: string;
  role: "OWNER" | "SUPPORT" | "BILLING";
}

/** Superadmin: requiere MFA (aal2) siempre. */
export async function requirePlatformAdmin(roles?: PlatformAdminContext["role"][]): Promise<PlatformAdminContext> {
  const identity = await requireIdentity();
  const admin = await platformDb().platformAdmin.findFirst({
    where: { id: identity.userId, deleted_at: null },
  });
  if (!admin) throw new DomainError("FORBIDDEN", "Acceso restringido a administradores de plataforma.");
  if (admin.mfa_required && identity.aal !== "aal2") {
    throw new DomainError("MFA_REQUIRED", "Debe completar la verificación en dos pasos.");
  }
  if (roles && !roles.includes(admin.role)) {
    throw new DomainError("FORBIDDEN", "Su rol de plataforma no permite esta acción.");
  }
  return { userId: admin.id, email: admin.email, role: admin.role };
}

/**
 * Reautenticación para acciones críticas: el último factor verificado
 * (TOTP / contraseña) debe tener menos de `maxAgeSeconds`. El cliente
 * fuerza un nuevo challenge MFA (supabase.auth.mfa.challengeAndVerify) antes de reintentar.
 */
export async function requireRecentAuth(maxAgeSeconds = 300): Promise<void> {
  const identity = await requireIdentity();
  const age = Math.floor(Date.now() / 1000) - identity.lastAuthAt;
  if (age > maxAgeSeconds) {
    throw new DomainError("REAUTH_REQUIRED", "Confirme su identidad nuevamente para continuar.");
  }
}
