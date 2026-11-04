import "server-only";
import { z } from "zod";
import { withTenant, type TenantDbContext, type Tx } from "@/lib/db";
import { audit } from "@/lib/audit";
import { D, type Decimal } from "@/lib/money";
import { DomainError } from "@/lib/result";
import { creditNoteEffect, earnAmount } from "./calc";

/** Fila del monedero bloqueada hasta el fin de la transacción: dos cajas no gastan el mismo saldo. */
async function lockWallet(tx: Tx, tenantId: string, customerId: string): Promise<{ id: string; balance: Decimal }> {
  await tx.$executeRaw`INSERT INTO customer_wallets (tenant_id, customer_id) VALUES (${tenantId}::uuid, ${customerId}::uuid)
    ON CONFLICT (tenant_id, customer_id) DO NOTHING`;
  const [row] = await tx.$queryRaw<{ id: string; balance: Decimal }[]>`
    SELECT id, balance FROM customer_wallets WHERE customer_id = ${customerId}::uuid FOR UPDATE`;
  return { id: row!.id, balance: D(row!.balance) };
}

async function move(tx: Tx, ctx: TenantDbContext, wallet: { id: string; balance: Decimal }, type: "EARN" | "REDEEM" | "EARN_REVERSAL" | "REDEEM_REFUND", amount: Decimal, documentId: string): Promise<Decimal> {
  const balance = wallet.balance.plus(amount);
  await tx.walletTransaction.create({
    data: { tenant_id: ctx.tenantId, wallet_id: wallet.id, type, amount: amount.toFixed(2), balance_after: balance.toFixed(2), document_id: documentId, created_by: ctx.userId },
  });
  await tx.customerWallet.update({ where: { id: wallet.id }, data: { balance: balance.toFixed(2) } });
  wallet.balance = balance;
  return balance;
}

export interface SaleWalletResult { redeemed: string; earned: string; balance: string }

/** Cobra con monedero y acredita lo ganado, dentro de la transacción de la venta. */
export async function applySaleWallet(tx: Tx, ctx: TenantDbContext, o: {
  customerId: string | null; documentId: string; total: Decimal; redeem: Decimal; paymentTerms: "Contado" | "Credito";
}): Promise<SaleWalletResult | null> {
  if (o.redeem.gt(0) && !o.customerId) throw new DomainError("WALLET_NEEDS_CUSTOMER", "Para pagar con monedero, identifique al cliente con su DNI o RUC.");
  if (!o.customerId) return null;
  const settings = await tx.loyaltySettings.findUnique({ where: { tenant_id: ctx.tenantId } });
  // Saldo a favor solo sobre ventas al contado: un crédito aún no está pagado
  const earn = settings?.enabled && o.paymentTerms === "Contado" ? earnAmount(o.total, o.redeem, settings.earn_percent) : D(0);
  if (o.redeem.lte(0) && earn.lte(0)) return null;

  const wallet = await lockWallet(tx, ctx.tenantId, o.customerId);
  if (o.redeem.gt(wallet.balance)) throw new DomainError("WALLET_INSUFFICIENT", `Saldo insuficiente en el monedero (S/ ${wallet.balance.toFixed(2)}).`);
  if (o.redeem.gt(0)) await move(tx, ctx, wallet, "REDEEM", o.redeem.negated(), o.documentId);
  if (earn.gt(0)) await move(tx, ctx, wallet, "EARN", earn, o.documentId);
  return { redeemed: o.redeem.toFixed(2), earned: earn.toFixed(2), balance: wallet.balance.toFixed(2) };
}

/** Nota de crédito: quita lo ganado y devuelve lo pagado con monedero, en proporción a lo devuelto. Retorna lo reintegrado al monedero. */
export async function applyCreditNoteWallet(tx: Tx, ctx: TenantDbContext, o: { customerId: string | null; saleId: string; noteId: string; noteTotal: Decimal; saleTotal: Decimal }): Promise<Decimal> {
  if (!o.customerId) return D(0);
  const moves = await tx.walletTransaction.findMany({ where: { document_id: o.saleId, type: { in: ["EARN", "REDEEM"] } } });
  if (moves.length === 0) return D(0);
  const wallet = await lockWallet(tx, ctx.tenantId, o.customerId);
  const earned = moves.find((m) => m.type === "EARN")?.amount ?? D(0);
  const redeemed = moves.find((m) => m.type === "REDEEM")?.amount.abs() ?? D(0);
  const { reverse, refund } = creditNoteEffect({ noteTotal: o.noteTotal, saleTotal: o.saleTotal, earned, redeemed, balance: wallet.balance });
  if (refund.gt(0)) await move(tx, ctx, wallet, "REDEEM_REFUND", refund, o.noteId);
  if (reverse.gt(0)) await move(tx, ctx, wallet, "EARN_REVERSAL", reverse.negated(), o.noteId);
  return refund;
}

/** Saldo para mostrar en caja al identificar al cliente. */
export async function walletBalance(ctx: TenantDbContext, docType: "DNI" | "RUC", docNumber: string): Promise<string | null> {
  return withTenant(ctx, async (tx) => {
    const customer = await tx.customer.findFirst({ where: { doc_type: docType, doc_number: docNumber, deleted_at: null }, include: { wallet: { select: { balance: true } } } });
    return customer ? (customer.wallet?.balance.toFixed(2) ?? "0.00") : null;
  });
}

export const loyaltySchema = z.object({
  enabled: z.boolean(),
  earnPercent: z.union([z.number(), z.string()]).transform((v) => D(String(v).replace(",", ".") || "0")).refine((d) => d.gte(0) && d.lte(50), "El porcentaje debe estar entre 0 y 50"),
});

export async function saveLoyaltySettings(ctx: TenantDbContext, raw: z.input<typeof loyaltySchema>): Promise<void> {
  const i = loyaltySchema.parse(raw);
  await withTenant(ctx, async (tx) => {
    const data = { enabled: i.enabled, earn_percent: i.earnPercent.toFixed(2) };
    await tx.loyaltySettings.upsert({ where: { tenant_id: ctx.tenantId }, create: { tenant_id: ctx.tenantId, ...data }, update: data });
    await audit(tx, {
      tenantId: ctx.tenantId, actorUserId: ctx.userId, actorKind: "tenant_user", action: "loyalty.settings",
      entityType: "tenant", entityId: ctx.tenantId, after: data,
    });
  });
}
