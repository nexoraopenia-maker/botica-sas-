import "server-only";
import { z } from "zod";
import { withTenant, type TenantDbContext } from "@/lib/db";
import { audit } from "@/lib/audit";
import { hasPermission } from "@/lib/auth/permissions";
import { D, round2 } from "@/lib/money";
import { DomainError } from "@/lib/result";
import { limaNow } from "@/lib/time";

export const WASTE_REASONS = {
  EXPIRED: "Vencido",
  DAMAGED: "Dañado o roto",
  RECALL: "Retiro del mercado (alerta DIGEMID)",
  OTHER: "Otro",
} as const;
export type WasteReason = keyof typeof WASTE_REASONS;

export const wasteSchema = z.object({
  idempotencyKey: z.uuid(),
  batchId: z.uuid(),
  quantity: z.union([z.number(), z.string()]).transform((v) => D(String(v).replace(",", "."))).refine((d) => d.gt(0), "La cantidad debe ser mayor a 0"),
  reason: z.enum(["EXPIRED", "DAMAGED", "RECALL", "OTHER"]),
  note: z.string().trim().min(5, "Explique el motivo (mínimo 5 caracteres)").max(250),
});

export interface WasteResult {
  movementId: string;
  product: string;
  lot: string;
  quantity: string;
  balance: string;
  /** Costo de lo dado de baja */
  value: string;
  replayed: boolean;
}

export const CONTROLLED_WASTE_MESSAGE = "Solo el Químico Farmacéutico o Administrador puede registrar mermas de medicamentos controlados.";

interface BatchRow { id: string; branch_id: string; product_id: string; lot_code: string; expiry_date: Date | null; stock: string; unit_cost: string }

/**
 * Da de baja stock de un lote por vencimiento, daño, retiro del mercado u otro motivo. Deja el movimiento WASTE en el kardex
 * (con lote, costo y quién), la entrada en el libro de controlados si corresponde, y el registro de auditoría.
 * `permissions` son los de la sesión; sin ellos no se dan de baja controlados (niega por defecto).
 */
export async function registerWaste(ctx: TenantDbContext & { permissions?: readonly string[] }, raw: z.input<typeof wasteSchema>): Promise<WasteResult> {
  const input = wasteSchema.parse(raw);
  const today = limaNow().date;

  return withTenant(ctx, async (tx) => {
    // Reintento con la misma clave: devuelve la merma ya registrada, no descuenta dos veces
    const dup = await tx.stockMovement.findFirst({ where: { ref_type: "waste", ref_id: input.idempotencyKey, type: "WASTE" }, include: { batch: { select: { lot_code: true } }, product: { select: { name: true } } } });
    if (dup) {
      return {
        movementId: String(dup.id), product: dup.product.name, lot: dup.batch?.lot_code ?? "", quantity: dup.quantity.abs().toString(), balance: dup.balance_after.toString(),
        value: round2(dup.quantity.abs().times(dup.unit_cost ?? 0)).toFixed(2), replayed: true,
      };
    }

    const [batch] = await tx.$queryRaw<BatchRow[]>`
      SELECT id, branch_id, product_id, lot_code, expiry_date, stock::text, unit_cost::text
        FROM product_batches WHERE id = ${input.batchId}::uuid AND deleted_at IS NULL FOR UPDATE`;
    if (!batch) throw new DomainError("NOT_FOUND", "Lote no encontrado.");
    const product = await tx.product.findFirstOrThrow({ where: { id: batch.product_id }, select: { name: true, is_controlled: true, allow_fractional: true } });

    if (product.is_controlled && !hasPermission(ctx.permissions ?? [], "pharmacy.controlled_log")) throw new DomainError("FORBIDDEN", CONTROLLED_WASTE_MESSAGE);
    const stock = D(batch.stock);
    if (input.quantity.gt(stock)) throw new DomainError("INSUFFICIENT_STOCK", `El lote ${batch.lot_code} solo tiene ${stock.toString()} unidades.`);
    if (!product.allow_fractional && !input.quantity.isInteger()) throw new DomainError("VALIDATION", `${product.name} no admite cantidades fraccionadas.`);
    const expired = !!batch.expiry_date && batch.expiry_date.toISOString().slice(0, 10) < today;
    if (input.reason === "EXPIRED" && !expired) throw new DomainError("VALIDATION", `El lote ${batch.lot_code} no está vencido: elija otro motivo.`);

    const balance = stock.minus(input.quantity);
    const value = round2(input.quantity.times(batch.unit_cost));
    const label = WASTE_REASONS[input.reason];
    try {
      await tx.productBatch.update({ where: { id: batch.id }, data: { stock: balance } });
      const movement = await tx.stockMovement.create({
        data: {
          tenant_id: ctx.tenantId, branch_id: batch.branch_id, product_id: batch.product_id, batch_id: batch.id, type: "WASTE",
          quantity: input.quantity.negated(), balance_after: balance, unit_cost: batch.unit_cost, ref_type: "waste", ref_id: input.idempotencyKey,
          note: `${label}: ${input.note}`, created_by: ctx.userId,
        },
      });
      // Un controlado que sale por merma también sale del libro: su saldo sigue al stock físico
      if (product.is_controlled) {
        await tx.controlledSubstanceLog.create({
          data: {
            tenant_id: ctx.tenantId, branch_id: batch.branch_id, product_id: batch.product_id, batch_id: batch.id, movement: "OUT", quantity: input.quantity, balance: 0,
            counterparty: `Merma: ${label}`, recorded_by: ctx.userId,
          },
        });
      }
      await audit(tx, {
        tenantId: ctx.tenantId, actorUserId: ctx.userId, actorKind: "tenant_user", action: "inventory.waste", entityType: "product_batch", entityId: batch.id,
        reason: input.note,
        before: { stock: stock.toString() },
        after: { stock: balance.toString(), quantity: input.quantity.toString(), reason: input.reason, lot: batch.lot_code, product: product.name, value: value.toFixed(2), expired },
      });
      return { movementId: String(movement.id), product: product.name, lot: batch.lot_code, quantity: input.quantity.toString(), balance: balance.toString(), value: value.toFixed(2), replayed: false };
    } catch (err) {
      if (err instanceof Error && err.message.includes("Saldo negativo en libro de controlados")) {
        throw new DomainError("CONTROLLED_NO_BALANCE", "El libro de controlados no tiene saldo suficiente de este producto: revise el libro antes de dar la merma.");
      }
      throw err;
    }
  });
}
