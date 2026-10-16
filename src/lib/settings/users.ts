import "server-only";
import { randomInt } from "node:crypto";
import { z } from "zod";
import { platformDb, withTenant, type TenantDbContext } from "@/lib/db";
import { audit } from "@/lib/audit";
import { env } from "@/lib/env";
import { DomainError } from "@/lib/result";
import { supabaseAdmin } from "@/lib/supabase/server";

export const addMemberSchema = z.object({
  email: z.email("Correo inválido").transform((e) => e.trim().toLowerCase()),
  fullName: z.string().trim().min(3, "Nombre completo (mínimo 3 caracteres)").max(120),
  roleKey: z.string().min(1).max(40),
  branchIds: z.array(z.uuid()).default([]),
  mode: z.enum(["invite", "temp_password"]),
});

export const updateMemberSchema = z.object({
  memberId: z.uuid(),
  roleKey: z.string().min(1).max(40),
  branchIds: z.array(z.uuid()).default([]),
  status: z.enum(["ACTIVE", "DISABLED"]),
});

/** Contraseña temporal legible (sin caracteres ambiguos), 12 caracteres. */
function tempPassword(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  return Array.from({ length: 12 }, () => chars[randomInt(chars.length)]).join("");
}

async function seatsInfo(ctx: TenantDbContext) {
  return withTenant(ctx, async (tx) => {
    const [sub, used] = await Promise.all([
      tx.subscription.findFirst({ where: { status: { in: ["ACTIVE", "TRIALING", "PAST_DUE"] } }, include: { plan: true }, orderBy: { created_at: "desc" } }),
      tx.tenantUser.count({ where: { deleted_at: null, status: { in: ["ACTIVE", "INVITED"] } } }),
    ]);
    return { limit: sub?.plan.max_users ?? 1, used };
  });
}

export interface AddMemberResult {
  memberId: string;
  /** Solo en modo contraseña temporal: se muestra una única vez al administrador */
  tempPassword?: string;
  existingAccount: boolean;
}

/**
 * Alta de un usuario del negocio.
 *  • invite: Supabase envía un correo para que el usuario cree su contraseña (/auth/accept-invite).
 *  • temp_password: se crea la cuenta confirmada con una contraseña temporal (útil para cajeros sin correo
 *    propio o con correos internos que no reciben mensajes); no se envía ningún correo.
 * Si el correo ya tiene cuenta (p. ej. trabaja en otro negocio), se agrega la membresía sin tocar su contraseña.
 */
export async function addMember(ctx: TenantDbContext, raw: z.input<typeof addMemberSchema>): Promise<AddMemberResult> {
  const i = addMemberSchema.parse(raw);
  const db = platformDb();

  const { limit, used } = await seatsInfo(ctx);
  if (used >= limit) throw new DomainError("PLAN_LIMIT", `Su plan permite ${limit} usuario(s). Desactive uno o contacte a soporte para ampliarlo.`);

  // Rol y sucursales deben pertenecer al tenant (consulta con RLS)
  const { role, validBranches } = await withTenant(ctx, async (tx) => ({
    role: await tx.role.findFirst({ where: { key: i.roleKey, deleted_at: null } }),
    validBranches: await tx.branch.count({ where: { id: { in: i.branchIds }, deleted_at: null } }),
  }));
  if (!role) throw new DomainError("VALIDATION", "Rol inválido.");
  if (validBranches !== i.branchIds.length) throw new DomainError("VALIDATION", "Sucursal inválida.");

  let userId: string;
  let password: string | undefined;
  const existing = await db.user.findUnique({ where: { email: i.email } });

  if (existing) {
    const member = await db.tenantUser.findUnique({ where: { tenant_id_user_id: { tenant_id: ctx.tenantId, user_id: existing.id } } });
    if (member && !member.deleted_at) throw new DomainError("DUPLICATE", "Ese correo ya es usuario de su negocio.");
    userId = existing.id;
  } else if (i.mode === "invite") {
    const { data, error } = await supabaseAdmin().auth.admin.inviteUserByEmail(i.email, {
      redirectTo: `${env().NEXT_PUBLIC_APP_URL}/auth/accept-invite`,
      data: { full_name: i.fullName },
    });
    if (error || !data.user) {
      throw new DomainError("INVITE_FAILED", /already|registered|exists/i.test(error?.message ?? "")
        ? "Ese correo ya tiene una cuenta en la plataforma. Use «Crear con contraseña temporal» o pida soporte."
        : `No se pudo enviar la invitación: ${error?.message ?? "error desconocido"}`);
    }
    userId = data.user.id;
  } else {
    password = tempPassword();
    const { data, error } = await supabaseAdmin().auth.admin.createUser({
      email: i.email, password, email_confirm: true, user_metadata: { full_name: i.fullName },
    });
    if (error || !data.user) {
      throw new DomainError("CREATE_FAILED", /already|registered|exists/i.test(error?.message ?? "")
        ? "Ese correo ya tiene una cuenta en la plataforma."
        : `No se pudo crear el usuario: ${error?.message ?? "error desconocido"}`);
    }
    userId = data.user.id;
  }

  // El perfil (tabla users) no es escribible por el runtime de tenant: se registra con el cliente de plataforma,
  // ya verificado el permiso users.manage y el tenant de la sesión.
  const memberId = await db.$transaction(async (tx) => {
    await tx.user.upsert({ where: { id: userId }, create: { id: userId, email: i.email, full_name: i.fullName }, update: {} });
    const m = await tx.tenantUser.upsert({
      where: { tenant_id_user_id: { tenant_id: ctx.tenantId, user_id: userId } },
      create: {
        tenant_id: ctx.tenantId, user_id: userId, role_id: role.id, branch_ids: i.branchIds,
        status: existing || password ? "ACTIVE" : "INVITED", invited_by: ctx.userId, invited_at: new Date(),
        accepted_at: existing || password ? new Date() : null,
      },
      update: { role_id: role.id, branch_ids: i.branchIds, status: "ACTIVE", deleted_at: null },
    });
    await audit(tx, {
      tenantId: ctx.tenantId, actorUserId: ctx.userId, actorKind: "tenant_user", action: "member.add", entityType: "tenant_user", entityId: m.id,
      after: { email: i.email, role: role.key, mode: existing ? "existing_account" : i.mode, branches: i.branchIds.length },
    });
    return m.id;
  });

  return { memberId, tempPassword: password, existingAccount: !!existing };
}

/** Cambio de rol, sucursales o estado. Reglas: no puede quitarse a sí mismo el acceso y siempre queda un administrador activo. */
export async function updateMember(ctx: TenantDbContext, raw: z.input<typeof updateMemberSchema>): Promise<void> {
  const i = updateMemberSchema.parse(raw);
  await withTenant(ctx, async (tx) => {
    const m = await tx.tenantUser.findFirst({ where: { id: i.memberId, deleted_at: null }, include: { role: true } });
    if (!m) throw new DomainError("NOT_FOUND", "Usuario no encontrado.");
    const role = await tx.role.findFirst({ where: { key: i.roleKey, deleted_at: null } });
    if (!role) throw new DomainError("VALIDATION", "Rol inválido.");
    const branches = await tx.branch.count({ where: { id: { in: i.branchIds }, deleted_at: null } });
    if (branches !== i.branchIds.length) throw new DomainError("VALIDATION", "Sucursal inválida.");

    const losesAdmin = m.role.key === "admin" && (role.key !== "admin" || i.status !== "ACTIVE");
    if (m.user_id === ctx.userId && (losesAdmin || i.status !== "ACTIVE")) {
      throw new DomainError("SELF_LOCKOUT", "No puede quitarse a sí mismo el rol de administrador ni desactivar su propio acceso.");
    }
    if (losesAdmin) {
      const admins = await tx.tenantUser.count({ where: { id: { not: m.id }, deleted_at: null, status: "ACTIVE", role: { key: "admin" } } });
      if (admins === 0) throw new DomainError("LAST_ADMIN", "Debe quedar al menos un administrador activo.");
    }
    const status = m.status === "INVITED" && i.status === "ACTIVE" ? "INVITED" : i.status; // una invitación sigue pendiente
    await tx.tenantUser.update({ where: { id: m.id }, data: { role_id: role.id, branch_ids: i.branchIds, status } });
    await audit(tx, {
      tenantId: ctx.tenantId, actorUserId: ctx.userId, actorKind: "tenant_user", action: "member.update", entityType: "tenant_user", entityId: m.id,
      before: { role: m.role.key, status: m.status, branches: m.branch_ids.length },
      after: { role: role.key, status, branches: i.branchIds.length },
    });
  });
}
