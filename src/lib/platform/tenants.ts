import "server-only";
import type { ModuleKey } from "@/generated/prisma/enums";
import { platformDb, Prisma, type Tx } from "@/lib/db";
import { audit } from "@/lib/audit";
import { DomainError } from "@/lib/result";
import { SYSTEM_ROLES } from "@/lib/auth/permissions";
import { MODULE_DEPENDENCIES } from "@/lib/modules/registry";
import { supabaseAdmin } from "@/lib/supabase/server";
import { env } from "@/lib/env";
import { addDays } from "@/lib/time";
import type { PlatformAdminContext } from "@/lib/auth/session";
import {
  createTenantSchema, deletionSchema, purgeSchema, setModulesSchema, suspendSchema, updateTenantSchema,
  type CreateTenantInput,
} from "@/lib/platform/schemas";
import type { z } from "zod";

const LINE_MODULES: Record<string, ModuleKey[]> = {
  AGROVET: ["AGRO", "VETERINARY"],
  VETERINARY: ["VETERINARY"],
  PHARMACY: ["PHARMACY"],
  RETAIL: [],
};

const DEFAULT_ALERTS = [
  { kind: "BATCH_EXPIRY" as const, thresholds: [90, 60, 30, 15, 7, 0], channels: ["IN_APP" as const], recipient_roles: ["admin", "warehouse", "pharmacist"] },
  { kind: "LOW_STOCK" as const, thresholds: [], channels: ["IN_APP" as const], recipient_roles: ["admin", "warehouse"] },
  { kind: "VACCINE_DUE" as const, thresholds: [7, 3, 1, 0], channels: ["WHATSAPP" as const, "EMAIL" as const, "IN_APP" as const], recipient_roles: ["admin", "veterinarian"] },
  { kind: "CERTIFICATE_EXPIRY" as const, thresholds: [30, 15, 7, 1], channels: ["IN_APP" as const, "EMAIL" as const], recipient_roles: ["admin"] },
];

function resolveModules(requested: ModuleKey[]): ModuleKey[] {
  const set = new Set<ModuleKey>(["CORE", ...requested]);
  for (const m of set) {
    for (const dep of MODULE_DEPENDENCIES[m] ?? []) {
      if (!set.has(dep)) throw new DomainError("MODULE_DEPENDENCY", `${m} requiere el módulo ${dep}.`);
    }
  }
  return [...set];
}

async function adminAudit(tx: Tx, admin: PlatformAdminContext, tenantId: string, action: string, extra: { before?: Prisma.InputJsonValue; after?: Prisma.InputJsonValue; reason?: string } = {}) {
  await audit(tx, {
    tenantId, actorUserId: admin.userId, actorKind: "platform_admin", action, entityType: "tenant", entityId: tenantId, ...extra,
  });
}

/** Alta completa de tenant: fiscal, sucursal 0000, roles, módulos, suscripción de prueba, series e invitación. */
export async function createTenant(admin: PlatformAdminContext, raw: CreateTenantInput): Promise<{ tenantId: string }> {
  const input = createTenantSchema.parse(raw);
  const db = platformDb();
  const plan = await db.plan.findFirst({ where: { id: input.planId, deleted_at: null } });
  if (!plan) throw new DomainError("PLAN_NOT_FOUND", "Plan no encontrado.");

  const modules = resolveModules(
    input.modules ?? [...input.businessLines.flatMap((l) => LINE_MODULES[l] ?? []), ...plan.included_modules],
  );

  // 1) Invitación (fuera de la transacción: es un servicio externo; si falla no se crea nada)
  const { data: invite, error: inviteErr } = await supabaseAdmin().auth.admin.inviteUserByEmail(input.adminEmail, {
    redirectTo: `${env().NEXT_PUBLIC_APP_URL}/auth/accept-invite`,
    data: { full_name: input.adminFullName },
  });
  let adminUserId = invite?.user?.id;
  if (inviteErr) {
    // Usuario ya existente (pertenece a otro tenant): se reutiliza
    const existing = await db.user.findUnique({ where: { email: input.adminEmail } });
    if (!existing) throw new DomainError("INVITE_FAILED", `No se pudo invitar al administrador: ${inviteErr.message}`);
    adminUserId = existing.id;
  }

  try {
    const tenantId = await db.$transaction(async (tx) => {
      const now = new Date();
      const tenant = await tx.tenant.create({
        data: {
          slug: input.slug, ruc: input.ruc, legal_name: input.legalName, trade_name: input.tradeName ?? null,
          business_lines: input.businessLines, fiscal_address: input.fiscalAddress, ubigeo: input.ubigeo,
          department: input.department, province: input.province, district: input.district,
          urbanization: input.urbanization ?? null, contact_name: input.contactName, contact_email: input.contactEmail,
          contact_phone: input.contactPhone ?? null, ose_provider: input.oseProvider, ose_endpoint: input.oseEndpoint ?? null,
          status: "TRIAL", sunat_env: "BETA", onboarding_step: 1,
        },
      });
      const branch = await tx.branch.create({
        data: { tenant_id: tenant.id, sunat_code: "0000", name: "Principal", address: input.fiscalAddress, ubigeo: input.ubigeo },
      });
      await tx.documentSeries.createMany({
        data: [
          { tenant_id: tenant.id, branch_id: branch.id, doc_type: "FACTURA", series: "F001" },
          { tenant_id: tenant.id, branch_id: branch.id, doc_type: "BOLETA", series: "B001" },
          { tenant_id: tenant.id, branch_id: branch.id, doc_type: "NOTA_CREDITO", series: "FC01" },
          { tenant_id: tenant.id, branch_id: branch.id, doc_type: "NOTA_CREDITO", series: "BC01" },
          { tenant_id: tenant.id, branch_id: branch.id, doc_type: "NOTA_DEBITO", series: "FD01" },
          { tenant_id: tenant.id, branch_id: branch.id, doc_type: "NOTA_DEBITO", series: "BD01" },
        ],
      });
      const roles = await Promise.all(
        Object.entries(SYSTEM_ROLES).map(([key, r]) =>
          tx.role.create({ data: { tenant_id: tenant.id, key, name: r.name, permissions: [...r.permissions], is_system: true } }),
        ),
      );
      await tx.tenantModule.createMany({ data: modules.map((m) => ({ tenant_id: tenant.id, module: m, enabled_by: admin.userId })) });
      await tx.subscription.create({
        data: {
          tenant_id: tenant.id, plan_id: plan.id, status: "TRIALING", trial_ends_at: addDays(now, plan.trial_days),
          current_period_start: now, current_period_end: addDays(now, plan.trial_days),
        },
      });
      await tx.alertRule.createMany({ data: DEFAULT_ALERTS.map((a) => ({ tenant_id: tenant.id, ...a })) });

      await tx.user.upsert({
        where: { id: adminUserId! },
        create: { id: adminUserId!, email: input.adminEmail, full_name: input.adminFullName },
        update: {},
      });
      await tx.tenantUser.create({
        data: {
          tenant_id: tenant.id, user_id: adminUserId!, role_id: roles.find((r) => r.key === "admin")!.id,
          status: inviteErr ? "ACTIVE" : "INVITED", invited_by: admin.userId, invited_at: now,
        },
      });
      await adminAudit(tx, admin, tenant.id, "tenant.create", { after: { ruc: input.ruc, slug: input.slug, plan: plan.code, modules } });
      return tenant.id;
    });
    return { tenantId };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw new DomainError("DUPLICATE_TENANT", "Ya existe un cliente con ese RUC o identificador.");
    }
    throw err;
  }
}

export async function updateTenant(admin: PlatformAdminContext, raw: z.input<typeof updateTenantSchema>): Promise<void> {
  const i = updateTenantSchema.parse(raw);
  await platformDb().$transaction(async (tx) => {
    const before = await tx.tenant.findUniqueOrThrow({ where: { id: i.tenantId } });
    if (i.sunatEnv === "PRODUCTION" && !before.sunat_beta_passed_at) {
      throw new DomainError("BETA_REQUIRED", "Debe aprobar la prueba en ambiente beta antes de pasar a producción.");
    }
    if (i.sunatEnv === "PRODUCTION" && (!before.certificate_expires_at || before.certificate_expires_at < new Date())) {
      throw new DomainError("CERT_REQUIRED", "Se requiere un certificado digital vigente para producción.");
    }
    const after = await tx.tenant.update({
      where: { id: i.tenantId },
      data: {
        ruc: i.ruc, legal_name: i.legalName, trade_name: i.tradeName, fiscal_address: i.fiscalAddress, ubigeo: i.ubigeo,
        department: i.department, province: i.province, district: i.district, urbanization: i.urbanization,
        business_lines: i.businessLines, contact_name: i.contactName, contact_email: i.contactEmail,
        contact_phone: i.contactPhone, logo_path: i.logoPath, ose_provider: i.oseProvider, ose_endpoint: i.oseEndpoint,
        sunat_env: i.sunatEnv,
      },
    });
    await adminAudit(tx, admin, i.tenantId, "tenant.update", {
      before: { ruc: before.ruc, legal_name: before.legal_name, sunat_env: before.sunat_env, ose_endpoint: before.ose_endpoint },
      after: { ruc: after.ruc, legal_name: after.legal_name, sunat_env: after.sunat_env, ose_endpoint: after.ose_endpoint },
    });
  });
}

export async function setModules(admin: PlatformAdminContext, raw: z.input<typeof setModulesSchema>): Promise<ModuleKey[]> {
  const i = setModulesSchema.parse(raw);
  const modules = resolveModules(i.modules);
  await platformDb().$transaction(async (tx) => {
    const before = await tx.tenantModule.findMany({ where: { tenant_id: i.tenantId, enabled: true } });
    await tx.tenantModule.updateMany({ where: { tenant_id: i.tenantId, module: { notIn: modules } }, data: { enabled: false } });
    for (const m of modules) {
      await tx.tenantModule.upsert({
        where: { tenant_id_module: { tenant_id: i.tenantId, module: m } },
        create: { tenant_id: i.tenantId, module: m, enabled_by: admin.userId },
        update: { enabled: true, enabled_by: admin.userId, enabled_at: new Date() },
      });
    }
    await adminAudit(tx, admin, i.tenantId, "tenant.modules", { before: before.map((b) => b.module), after: modules });
  });
  return modules;
}

export async function suspendTenant(admin: PlatformAdminContext, raw: z.input<typeof suspendSchema>): Promise<void> {
  const i = suspendSchema.parse(raw);
  await platformDb().$transaction(async (tx) => {
    const t = await tx.tenant.findUniqueOrThrow({ where: { id: i.tenantId } });
    if (t.status === "DELETED") throw new DomainError("INVALID_STATE", "El cliente fue eliminado.");
    await tx.tenant.update({ where: { id: t.id }, data: { status: "SUSPENDED", suspended_at: new Date(), suspension_reason: i.reason } });
    await tx.subscription.updateMany({ where: { tenant_id: t.id, status: { in: ["ACTIVE", "TRIALING", "PAST_DUE"] } }, data: { status: "SUSPENDED" } });
    await adminAudit(tx, admin, t.id, "tenant.suspend", { before: { status: t.status }, after: { status: "SUSPENDED" }, reason: i.reason });
  });
  // Cierra sesiones de los usuarios del tenant: el guard ya bloquea por estado, esto acelera el efecto
}

export async function reactivateTenant(admin: PlatformAdminContext, tenantId: string, reason: string): Promise<void> {
  await platformDb().$transaction(async (tx) => {
    const t = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    if (!["SUSPENDED", "PENDING_DELETION"].includes(t.status)) throw new DomainError("INVALID_STATE", "El cliente no está suspendido.");
    await tx.tenant.update({
      where: { id: tenantId },
      data: { status: "ACTIVE", suspended_at: null, suspension_reason: null, deletion_requested_at: null, purge_after: null },
    });
    await tx.subscription.updateMany({ where: { tenant_id: tenantId, status: "SUSPENDED" }, data: { status: "ACTIVE" } });
    await adminAudit(tx, admin, tenantId, "tenant.reactivate", { before: { status: t.status }, after: { status: "ACTIVE" }, reason });
  });
}

/** Soft delete: bloquea acceso, programa purga tras periodo de gracia y solicita exportación completa. */
export async function requestTenantDeletion(admin: PlatformAdminContext, raw: z.input<typeof deletionSchema>): Promise<{ purgeAfter: Date }> {
  const i = deletionSchema.parse(raw);
  const purgeAfter = addDays(new Date(), i.graceDays);
  await platformDb().$transaction(async (tx) => {
    const t = await tx.tenant.findUniqueOrThrow({ where: { id: i.tenantId } });
    await tx.tenant.update({
      where: { id: t.id },
      data: { status: "PENDING_DELETION", deletion_requested_at: new Date(), purge_after: purgeAfter },
    });
    await tx.subscription.updateMany({ where: { tenant_id: t.id }, data: { status: "CANCELED", canceled_at: new Date() } });
    const exp = await tx.tenantExport.create({ data: { tenant_id: t.id, requested_by: admin.userId } });
    await tx.outboxEvent.create({
      data: { tenant_id: t.id, aggregate_type: "tenant_export", aggregate_id: exp.id, event_type: "tenant.export", payload: { exportId: exp.id }, dedupe_key: `tenant.export:${exp.id}` },
    });
    await adminAudit(tx, admin, t.id, "tenant.delete_requested", { before: { status: t.status }, after: { status: "PENDING_DELETION", purgeAfter: purgeAfter.toISOString() }, reason: i.reason });
  });
  return { purgeAfter };
}

/** Hard delete (doble confirmación). La función SQL conserva los comprobantes por retención legal. */
export async function purgeTenant(admin: PlatformAdminContext, raw: z.input<typeof purgeSchema>): Promise<void> {
  const i = purgeSchema.parse(raw);
  if (admin.role !== "OWNER") throw new DomainError("FORBIDDEN", "Solo el propietario de la plataforma puede purgar clientes.");
  const t = await platformDb().tenant.findUniqueOrThrow({ where: { id: i.tenantId } });
  if (i.confirmPhrase !== `ELIMINAR ${t.slug}`) {
    throw new DomainError("CONFIRMATION_MISMATCH", `Escriba exactamente: ELIMINAR ${t.slug}`);
  }
  await platformDb().$executeRaw`SELECT app.purge_tenant(${i.tenantId}::uuid, ${i.confirmRuc}, ${admin.userId}::uuid)`;
}
