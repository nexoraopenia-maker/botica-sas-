import "server-only";
import { z } from "zod";
import { Prisma, withTenant, type TenantDbContext } from "@/lib/db";
import { audit } from "@/lib/audit";
import { DomainError } from "@/lib/result";

// ───────────────────────────── Sucursales ─────────────────────────────

const ubigeo = z.string().regex(/^\d{6}$/, "Ubigeo de 6 dígitos");

export const createBranchSchema = z.object({
  sunatCode: z.string().regex(/^\d{4}$/, "Código de establecimiento SUNAT de 4 dígitos (ej. 0001)"),
  name: z.string().trim().min(2).max(80),
  address: z.string().trim().min(5).max(250),
  ubigeo,
  phone: z.string().trim().max(20).optional(),
});

export const updateBranchSchema = z.object({
  branchId: z.uuid(),
  name: z.string().trim().min(2).max(80),
  address: z.string().trim().min(5).max(250),
  ubigeo,
  phone: z.string().trim().max(20).optional(),
  isActive: z.boolean(),
});

export async function createBranch(ctx: TenantDbContext, raw: z.input<typeof createBranchSchema>): Promise<{ branchId: string }> {
  const i = createBranchSchema.parse(raw);
  try {
    return await withTenant(ctx, async (tx) => {
      const [sub, count] = await Promise.all([
        tx.subscription.findFirst({ where: { status: { in: ["ACTIVE", "TRIALING", "PAST_DUE"] } }, include: { plan: true }, orderBy: { created_at: "desc" } }),
        tx.branch.count({ where: { deleted_at: null, is_active: true } }),
      ]);
      const limit = sub?.plan.max_branches ?? 1;
      if (count >= limit) {
        throw new DomainError("PLAN_LIMIT", `Su plan permite ${limit} sucursal(es) activa(s). Contacte a soporte para ampliarlo.`);
      }
      const b = await tx.branch.create({
        data: { tenant_id: ctx.tenantId, sunat_code: i.sunatCode, name: i.name, address: i.address, ubigeo: i.ubigeo, phone: i.phone ?? null },
      });
      await audit(tx, { tenantId: ctx.tenantId, actorUserId: ctx.userId, actorKind: "tenant_user", action: "branch.create", entityType: "branch", entityId: b.id, after: { sunat_code: b.sunat_code, name: b.name } });
      return { branchId: b.id };
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw new DomainError("DUPLICATE", `Ya existe una sucursal con el código ${i.sunatCode}.`);
    }
    throw err;
  }
}

export async function updateBranch(ctx: TenantDbContext, raw: z.input<typeof updateBranchSchema>): Promise<void> {
  const i = updateBranchSchema.parse(raw);
  await withTenant(ctx, async (tx) => {
    const before = await tx.branch.findFirst({ where: { id: i.branchId, deleted_at: null } });
    if (!before) throw new DomainError("NOT_FOUND", "Sucursal no encontrada.");
    if (before.is_active && !i.isActive) {
      const others = await tx.branch.count({ where: { id: { not: i.branchId }, is_active: true, deleted_at: null } });
      if (others === 0) throw new DomainError("LAST_BRANCH", "Debe quedar al menos una sucursal activa.");
    }
    const after = await tx.branch.update({
      where: { id: i.branchId },
      data: { name: i.name, address: i.address, ubigeo: i.ubigeo, phone: i.phone ?? null, is_active: i.isActive },
    });
    await audit(tx, {
      tenantId: ctx.tenantId, actorUserId: ctx.userId, actorKind: "tenant_user", action: "branch.update", entityType: "branch", entityId: i.branchId,
      before: { name: before.name, address: before.address, ubigeo: before.ubigeo, is_active: before.is_active },
      after: { name: after.name, address: after.address, ubigeo: after.ubigeo, is_active: after.is_active },
    });
  });
}

// ───────────────────────────── Series ─────────────────────────────

const DOC_TYPES = ["FACTURA", "BOLETA", "NOTA_CREDITO", "NOTA_DEBITO"] as const;

export const createSeriesSchema = z
  .object({
    branchId: z.uuid(),
    docType: z.enum(DOC_TYPES),
    series: z.string().trim().toUpperCase().regex(/^[FB][A-Z0-9]{3}$/, "4 caracteres: F o B seguido de 3 letras/números (ej. F002, B002, FC02)"),
  })
  .refine((v) => v.docType !== "FACTURA" || v.series.startsWith("F"), { message: "La serie de factura debe iniciar con F", path: ["series"] })
  .refine((v) => v.docType !== "BOLETA" || v.series.startsWith("B"), { message: "La serie de boleta debe iniciar con B", path: ["series"] });

export async function createSeries(ctx: TenantDbContext, raw: z.input<typeof createSeriesSchema>): Promise<void> {
  const i = createSeriesSchema.parse(raw);
  try {
    await withTenant(ctx, async (tx) => {
      const branch = await tx.branch.findFirst({ where: { id: i.branchId, deleted_at: null } });
      if (!branch) throw new DomainError("NOT_FOUND", "Sucursal no encontrada.");
      const s = await tx.documentSeries.create({ data: { tenant_id: ctx.tenantId, branch_id: i.branchId, doc_type: i.docType, series: i.series } });
      await audit(tx, { tenantId: ctx.tenantId, actorUserId: ctx.userId, actorKind: "tenant_user", action: "series.create", entityType: "document_series", entityId: s.id, after: { series: s.series, doc_type: s.doc_type, branch: branch.sunat_code } });
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw new DomainError("DUPLICATE", `La serie ${i.series} ya existe para ese tipo de comprobante.`);
    }
    throw err;
  }
}

export const toggleSeriesSchema = z.object({ seriesId: z.uuid(), isActive: z.boolean() });

/** Activar/desactivar. El correlativo nunca se edita (evita huecos y duplicados ante SUNAT). */
export async function toggleSeries(ctx: TenantDbContext, raw: z.input<typeof toggleSeriesSchema>): Promise<void> {
  const i = toggleSeriesSchema.parse(raw);
  await withTenant(ctx, async (tx) => {
    const s = await tx.documentSeries.findFirst({ where: { id: i.seriesId } });
    if (!s) throw new DomainError("NOT_FOUND", "Serie no encontrada.");
    if (s.is_active && !i.isActive) {
      const others = await tx.documentSeries.count({ where: { id: { not: s.id }, branch_id: s.branch_id, doc_type: s.doc_type, is_active: true } });
      if (others === 0 && (s.doc_type === "BOLETA" || s.doc_type === "FACTURA")) {
        throw new DomainError("LAST_SERIES", "Debe quedar al menos una serie activa de este tipo en la sucursal (la usa el punto de venta).");
      }
    }
    await tx.documentSeries.update({ where: { id: s.id }, data: { is_active: i.isActive } });
    await audit(tx, { tenantId: ctx.tenantId, actorUserId: ctx.userId, actorKind: "tenant_user", action: i.isActive ? "series.activate" : "series.deactivate", entityType: "document_series", entityId: s.id, after: { series: s.series, last_number: s.last_number } });
  });
}

// ───────────────────────────── Umbrales de alerta ─────────────────────────────

export const ALERT_KINDS = ["BATCH_EXPIRY", "LOW_STOCK", "VACCINE_DUE", "CERTIFICATE_EXPIRY"] as const;
export type AlertKindKey = (typeof ALERT_KINDS)[number];

export const ALERT_DEFAULTS: Record<AlertKindKey, { thresholds: number[]; channels: ("IN_APP" | "EMAIL" | "WHATSAPP")[]; roles: string[] }> = {
  BATCH_EXPIRY: { thresholds: [90, 60, 30, 15, 7, 0], channels: ["IN_APP"], roles: ["admin", "warehouse", "pharmacist"] },
  LOW_STOCK: { thresholds: [], channels: ["IN_APP"], roles: ["admin", "warehouse"] },
  VACCINE_DUE: { thresholds: [7, 3, 1, 0], channels: ["WHATSAPP", "EMAIL", "IN_APP"], roles: ["admin", "veterinarian"] },
  CERTIFICATE_EXPIRY: { thresholds: [30, 15, 7, 1], channels: ["IN_APP", "EMAIL"], roles: ["admin"] },
};

export const saveAlertRuleSchema = z.object({
  kind: z.enum(ALERT_KINDS),
  enabled: z.boolean(),
  thresholds: z.array(z.number().int().min(0).max(365)).max(10),
  channels: z.array(z.enum(["IN_APP", "EMAIL", "WHATSAPP"])).min(1, "Elija al menos un canal"),
  recipientRoles: z.array(z.string().min(1).max(40)).max(20),
});

export async function saveAlertRule(ctx: TenantDbContext & { modules: ReadonlySet<string> }, raw: z.input<typeof saveAlertRuleSchema>): Promise<void> {
  const i = saveAlertRuleSchema.parse(raw);
  if (i.kind === "VACCINE_DUE" && !ctx.modules.has("VETERINARY")) throw new DomainError("MODULE_DISABLED", "Requiere el módulo Veterinaria.");
  if (i.channels.includes("WHATSAPP") && !ctx.modules.has("WHATSAPP")) throw new DomainError("MODULE_DISABLED", "El canal WhatsApp requiere el módulo WhatsApp.");
  if (i.kind !== "LOW_STOCK" && i.thresholds.length === 0) throw new DomainError("VALIDATION", "Indique al menos un umbral en días.");
  const thresholds = [...new Set(i.thresholds)].sort((a, b) => b - a);

  await withTenant(ctx, async (tx) => {
    const roles = await tx.role.findMany({ where: { key: { in: i.recipientRoles }, deleted_at: null }, select: { key: true } });
    if (roles.length !== new Set(i.recipientRoles).size) throw new DomainError("VALIDATION", "Hay roles que no existen en su negocio.");
    const before = await tx.alertRule.findFirst({ where: { kind: i.kind } });
    await tx.alertRule.upsert({
      where: { tenant_id_kind: { tenant_id: ctx.tenantId, kind: i.kind } },
      create: { tenant_id: ctx.tenantId, kind: i.kind, enabled: i.enabled, thresholds, channels: i.channels, recipient_roles: i.recipientRoles },
      update: { enabled: i.enabled, thresholds, channels: i.channels, recipient_roles: i.recipientRoles },
    });
    await audit(tx, {
      tenantId: ctx.tenantId, actorUserId: ctx.userId, actorKind: "tenant_user", action: "alert_rule.update", entityType: "alert_rule", entityId: i.kind,
      before: before ? { enabled: before.enabled, thresholds: before.thresholds, channels: before.channels, roles: before.recipient_roles } : null,
      after: { enabled: i.enabled, thresholds, channels: i.channels, roles: i.recipientRoles },
    });
  });
}
