import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { withTenant, type TenantDbContext, type Tx } from "@/lib/db";
import { audit } from "@/lib/audit";
import { D } from "@/lib/money";
import { DomainError } from "@/lib/result";
import { limaNow } from "@/lib/time";
import { isValidRuc } from "@/lib/sunat/validation";
import { normalizePeruPhone } from "@/lib/notifications/providers";
import { putObject, signedUrl, tenantPath } from "@/lib/storage";
import { canTransition, deliveryBlocker, detectImage, MAX_EVIDENCE, MAX_EVIDENCE_BYTES, ORDER_STATUSES, type OrderStatus } from "./rules";

const money = z.union([z.number(), z.string()]).transform((v) => D(String(v).replace(",", ".") || "0")).refine((d) => d.gte(0) && d.lte("999999999"), "Monto inválido");
const optText = (max: number) => z.string().trim().max(max).optional().transform((v) => (v ? v : undefined));

const customerSchema = z.object({
  docType: z.enum(["DNI", "RUC", "CE"]),
  docNumber: z.string().trim(),
  name: z.string().trim().min(3, "Nombre del cliente").max(200),
  phone: optText(20),
  whatsappOptIn: z.boolean().default(false),
}).superRefine((c, ctx) => {
  const valid = c.docType === "DNI" ? /^\d{8}$/.test(c.docNumber) : c.docType === "RUC" ? isValidRuc(c.docNumber) : /^[A-Za-z0-9]{9,12}$/.test(c.docNumber);
  if (!valid) ctx.addIssue({ code: "custom", path: ["docNumber"], message: `${c.docType} inválido` });
  if (c.phone && !normalizePeruPhone(c.phone)) ctx.addIssue({ code: "custom", path: ["phone"], message: "Teléfono inválido (ej. 987654321)" });
  if (c.whatsappOptIn && !c.phone) ctx.addIssue({ code: "custom", path: ["phone"], message: "Para enviar recordatorios se necesita el WhatsApp del cliente" });
});

const termsShape = {
  paymentType: z.enum(["CASH", "CREDIT"]),
  total: money,
  dueDate: z.iso.date().optional().or(z.literal("").transform(() => undefined)),
  invoiceNumber: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{1,4}-\d{1,8}$/, "Comprobante: formato F001-123").optional().or(z.literal("").transform(() => undefined)),
};

export const createOrderSchema = z.object({
  idempotencyKey: z.uuid(),
  branchId: z.uuid(),
  customer: customerSchema,
  itemDescription: z.string().trim().min(2, "Indique el vehículo o la pieza").max(200),
  plate: z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{3,10}$/, "Placa inválida").optional().or(z.literal("").transform(() => undefined)),
  mileage: z.number().int().min(0).max(5_000_000).optional(),
  problem: z.string().trim().min(3, "Describa el problema o trabajo solicitado").max(2000),
  notes: optText(2000),
  ...termsShape,
});

function assertTerms(i: { paymentType: "CASH" | "CREDIT"; dueDate?: string | undefined }, today: string): void {
  if (i.paymentType !== "CREDIT") return;
  if (!i.dueDate) throw new DomainError("DUE_DATE_REQUIRED", "Las órdenes a crédito requieren fecha de vencimiento.");
  if (i.dueDate < today) throw new DomainError("DUE_DATE_PAST", "La fecha de vencimiento no puede estar en el pasado.");
}
const asDate = (iso: string) => new Date(`${iso}T00:00:00Z`);

/** Bloquea la orden hasta el fin de la transacción: cobros y cambios de la misma orden se serializan. */
async function lockOrder(tx: Tx, orderId: string) {
  await tx.$queryRaw`SELECT id FROM service_orders WHERE id = ${orderId}::uuid AND deleted_at IS NULL FOR UPDATE`;
  const order = await tx.serviceOrder.findFirst({ where: { id: orderId, deleted_at: null } });
  if (!order) throw new DomainError("NOT_FOUND", "La orden no existe.");
  return order;
}

export interface CreatedOrder { orderId: string; number: number; replayed: boolean }

export async function createOrder(ctx: TenantDbContext, raw: z.input<typeof createOrderSchema>): Promise<CreatedOrder> {
  const i = createOrderSchema.parse(raw);
  assertTerms(i, limaNow().date);
  const phone = i.customer.phone ? normalizePeruPhone(i.customer.phone) : null;
  return withTenant(ctx, async (tx) => {
    // Correlativo sin huecos por carrera: una recepción a la vez por negocio
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`service-order:${ctx.tenantId}`}, 0))`;
    const existing = await tx.serviceOrder.findFirst({ where: { idempotency_key: i.idempotencyKey } });
    if (existing) return { orderId: existing.id, number: existing.number, replayed: true };

    const [customer] = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO customers (tenant_id, doc_type, doc_number, name, phone, whatsapp_opt_in)
      VALUES (${ctx.tenantId}::uuid, ${i.customer.docType}::"IdentityDocType", ${i.customer.docNumber}, ${i.customer.name}, ${phone}, ${i.customer.whatsappOptIn})
      ON CONFLICT (tenant_id, doc_type, doc_number) WHERE deleted_at IS NULL AND doc_type <> 'NO_DOC'
      DO UPDATE SET name = EXCLUDED.name, phone = coalesce(EXCLUDED.phone, customers.phone), whatsapp_opt_in = EXCLUDED.whatsapp_opt_in
      RETURNING id`;
    const last = await tx.serviceOrder.aggregate({ _max: { number: true } });
    const number = (last._max.number ?? 0) + 1;
    const id = randomUUID();
    await tx.serviceOrder.create({
      data: {
        id, tenant_id: ctx.tenantId, branch_id: i.branchId, customer_id: customer!.id, number, idempotency_key: i.idempotencyKey,
        item_description: i.itemDescription, plate: i.plate ?? null, mileage: i.mileage ?? null, problem: i.problem, notes: i.notes ?? null,
        payment_type: i.paymentType, total: i.total.toFixed(2), balance_due: i.total.toFixed(2),
        due_date: i.paymentType === "CREDIT" ? asDate(i.dueDate!) : null, invoice_number: i.invoiceNumber ?? null, created_by: ctx.userId,
      },
    });
    await audit(tx, {
      tenantId: ctx.tenantId, actorUserId: ctx.userId, actorKind: "tenant_user", action: "service_order.create",
      entityType: "service_order", entityId: id, after: { number, paymentType: i.paymentType, total: i.total.toFixed(2) },
    });
    return { orderId: id, number, replayed: false };
  });
}

export const updateTermsSchema = z.object({ orderId: z.uuid(), ...termsShape });

/** Condiciones de cobro. El saldo se recalcula con lo ya pagado; una orden entregada conserva su monto. */
export async function updateOrderTerms(ctx: TenantDbContext, raw: z.input<typeof updateTermsSchema>): Promise<void> {
  const i = updateTermsSchema.parse(raw);
  assertTerms(i, limaNow().date);
  await withTenant(ctx, async (tx) => {
    const o = await lockOrder(tx, i.orderId);
    const totalChanged = !o.total.eq(i.total);
    if (o.status === "DELIVERED" && (totalChanged || o.payment_type !== i.paymentType)) {
      throw new DomainError("ORDER_DELIVERED", "La orden ya se entregó: su monto y forma de pago no se pueden cambiar.");
    }
    const paid = o.total.minus(o.balance_due);
    if (i.total.lt(paid)) throw new DomainError("TOTAL_BELOW_PAID", `Ya se cobraron S/ ${paid.toFixed(2)}: el total no puede ser menor.`);
    await tx.serviceOrder.update({
      where: { id: o.id },
      data: {
        payment_type: i.paymentType, total: i.total.toFixed(2), balance_due: i.total.minus(paid).toFixed(2),
        due_date: i.paymentType === "CREDIT" ? asDate(i.dueDate!) : null, invoice_number: i.invoiceNumber ?? null,
      },
    });
    await audit(tx, {
      tenantId: ctx.tenantId, actorUserId: ctx.userId, actorKind: "tenant_user", action: "service_order.terms",
      entityType: "service_order", entityId: o.id,
      before: { total: o.total.toFixed(2), paymentType: o.payment_type, dueDate: o.due_date?.toISOString().slice(0, 10) ?? null },
      after: { total: i.total.toFixed(2), paymentType: i.paymentType, dueDate: i.dueDate ?? null },
    });
  });
}

export const changeStatusSchema = z.object({ orderId: z.uuid(), status: z.enum(ORDER_STATUSES) });

export async function changeOrderStatus(ctx: TenantDbContext, raw: z.input<typeof changeStatusSchema>): Promise<void> {
  const i = changeStatusSchema.parse(raw);
  await withTenant(ctx, async (tx) => {
    const o = await lockOrder(tx, i.orderId);
    if (!canTransition(o.status as OrderStatus, i.status)) throw new DomainError("INVALID_TRANSITION", "Ese cambio de estado no está permitido.");
    if (i.status === "DELIVERED") {
      const blocker = deliveryBlocker({
        paymentType: o.payment_type, total: o.total.toNumber(), balanceDue: o.balance_due.toNumber(), dueDate: o.due_date?.toISOString().slice(0, 10) ?? null,
      });
      if (blocker) throw new DomainError("CANNOT_DELIVER", blocker);
    }
    await tx.serviceOrder.update({ where: { id: o.id }, data: { status: i.status, delivered_at: i.status === "DELIVERED" ? new Date() : null } });
    await audit(tx, {
      tenantId: ctx.tenantId, actorUserId: ctx.userId, actorKind: "tenant_user", action: "service_order.status",
      entityType: "service_order", entityId: o.id, before: { status: o.status }, after: { status: i.status },
    });
  });
}

export const paymentSchema = z.object({
  idempotencyKey: z.uuid(),
  orderId: z.uuid(),
  amount: money.refine((d) => d.gt(0), "El monto debe ser mayor a cero"),
  method: z.enum(["EFECTIVO", "YAPE", "PLIN", "TARJETA", "TRANSFERENCIA"]),
  reference: optText(60),
});

/** Registra un cobro y baja el saldo en la misma transacción. Las órdenes a crédito exigen `canCollectCredit`. */
export async function registerPayment(ctx: TenantDbContext, raw: z.input<typeof paymentSchema>, caps: { canCollectCredit: boolean }): Promise<{ balanceDue: string; replayed: boolean }> {
  const i = paymentSchema.parse(raw);
  return withTenant(ctx, async (tx) => {
    const o = await lockOrder(tx, i.orderId);
    if (o.payment_type === "CREDIT" && !caps.canCollectCredit) throw new DomainError("FORBIDDEN", "No tiene permiso para cobrar créditos.");
    const dup = await tx.serviceOrderPayment.findFirst({ where: { idempotency_key: i.idempotencyKey } });
    if (dup) return { balanceDue: o.balance_due.toFixed(2), replayed: true };
    if (i.amount.gt(o.balance_due)) throw new DomainError("AMOUNT_EXCEEDS_BALANCE", `El cobro supera el saldo pendiente (S/ ${o.balance_due.toFixed(2)}).`);
    const balance = o.balance_due.minus(i.amount);
    await tx.serviceOrderPayment.create({
      data: { tenant_id: ctx.tenantId, order_id: o.id, idempotency_key: i.idempotencyKey, method: i.method, amount: i.amount.toFixed(2), reference: i.reference ?? null, created_by: ctx.userId },
    });
    await tx.serviceOrder.update({ where: { id: o.id }, data: { balance_due: balance.toFixed(2) } });
    await audit(tx, {
      tenantId: ctx.tenantId, actorUserId: ctx.userId, actorKind: "tenant_user", action: "service_order.payment",
      entityType: "service_order", entityId: o.id, after: { amount: i.amount.toFixed(2), method: i.method, balance: balance.toFixed(2) },
    });
    return { balanceDue: balance.toFixed(2), replayed: false };
  });
}

/** Guarda una foto de evidencia en el bucket privado. El archivo se valida por contenido, no por su nombre. */
export async function addEvidence(ctx: TenantDbContext, orderId: string, file: File): Promise<{ count: number }> {
  if (!z.uuid().safeParse(orderId).success) throw new DomainError("VALIDATION", "Orden inválida.");
  if (!(file instanceof File) || file.size === 0) throw new DomainError("VALIDATION", "Seleccione una foto.");
  if (file.size > MAX_EVIDENCE_BYTES) throw new DomainError("FILE_TOO_LARGE", "La foto es demasiado grande (máximo 4 MB).");
  const bytes = Buffer.from(await file.arrayBuffer());
  const kind = detectImage(bytes);
  if (!kind) throw new DomainError("INVALID_FILE", "El archivo no es una imagen JPG, PNG o WebP.");

  const before = await withTenant(ctx, (tx) => tx.serviceOrder.findFirst({ where: { id: orderId, deleted_at: null }, select: { evidence_urls: true } }));
  if (!before) throw new DomainError("NOT_FOUND", "La orden no existe.");
  if (before.evidence_urls.length >= MAX_EVIDENCE) throw new DomainError("EVIDENCE_LIMIT", `Máximo ${MAX_EVIDENCE} fotos por orden.`);

  const path = tenantPath(ctx.tenantId, "service-orders", orderId, `${randomUUID()}.${kind.ext}`);
  await putObject("tenant-files", path, bytes, kind.contentType);
  return withTenant(ctx, async (tx) => {
    const o = await lockOrder(tx, orderId);
    if (o.evidence_urls.length >= MAX_EVIDENCE) throw new DomainError("EVIDENCE_LIMIT", `Máximo ${MAX_EVIDENCE} fotos por orden.`);
    await tx.serviceOrder.update({ where: { id: o.id }, data: { evidence_urls: { push: path } } });
    await audit(tx, {
      tenantId: ctx.tenantId, actorUserId: ctx.userId, actorKind: "tenant_user", action: "service_order.evidence",
      entityType: "service_order", entityId: o.id, after: { path },
    });
    return { count: o.evidence_urls.length + 1 };
  });
}

/** Enlaces temporales para ver las fotos. Solo firma rutas de este negocio. */
export async function evidenceLinks(tenantId: string, paths: string[]): Promise<{ path: string; url: string | null }[]> {
  return Promise.all(paths.filter((p) => p.startsWith(`${tenantId}/`)).map(async (path) => ({
    path,
    url: await signedUrl("tenant-files", path, 900).catch((err: unknown) => {
      console.error("[taller] no se pudo firmar la foto", err instanceof Error ? err.message : err);
      return null;
    }),
  })));
}
