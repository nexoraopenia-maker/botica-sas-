import "server-only";
import { z } from "zod";
import { withTenant, type TenantDbContext } from "@/lib/db";
import { audit } from "@/lib/audit";
import { D } from "@/lib/money";
import { DomainError } from "@/lib/result";

export interface CommissionLine { id: string; label: string; date: string; base: string; percent: string; commission: string; isNote: boolean }
export interface SellerSummary { sellerId: string; name: string; documents: number; base: string; commission: string; lines: CommissionLine[] }

interface Row {
  id: string; doc_type: string; series: string; number: number; issue_date: Date; seller_id: string; base: string; percent: string | null;
}

/**
 * Comisión = venta sin IGV × % vigente al vender. Las notas de crédito restan a quien hizo la venta original.
 * Rechazados y anulados no comisionan; las ventas anteriores a este módulo no tienen vendedor asignado.
 */
export async function loadCommissions(ctx: TenantDbContext, from: string, to: string, sellerId?: string): Promise<{ sellers: SellerSummary[]; totalBase: string; totalCommission: string }> {
  return withTenant(ctx, async (tx) => {
    const rows = await tx.$queryRaw<Row[]>`
      SELECT d.id, d.doc_type::text, d.series, d.number, d.issue_date, d.seller_id,
             (d.op_gravadas + d.op_exoneradas + d.op_inafectas)::text AS base, d.seller_commission_percent::text AS percent
        FROM documents d
       WHERE d.seller_id IS NOT NULL AND d.deleted_at IS NULL
         AND d.doc_type IN ('FACTURA', 'BOLETA', 'NOTA_CREDITO') AND d.status NOT IN ('RECHAZADO', 'ANULADO')
         AND d.issue_date BETWEEN ${from}::date AND ${to}::date
         AND (${sellerId ?? null}::uuid IS NULL OR d.seller_id = ${sellerId ?? null}::uuid)
       ORDER BY d.issue_date DESC, d.series, d.number DESC`;
        const ids = [...new Set(rows.map((r) => r.seller_id))];
    const users = ids.length ? await tx.user.findMany({ where: { id: { in: ids } }, select: { id: true, full_name: true, email: true } }) : [];
    const name = new Map(users.map((u) => [u.id, u.full_name ?? u.email]));
    const map = new Map<string, SellerSummary & { b: ReturnType<typeof D>; c: ReturnType<typeof D> }>();
    let totalBase = D(0), totalCommission = D(0);
    for (const r of rows) {
      const sign = r.doc_type === "NOTA_CREDITO" ? -1 : 1;
      const base = D(r.base).times(sign);
      const pct = D(r.percent ?? 0);
      const commission = base.times(pct).div(100).toDecimalPlaces(2);
      const s = map.get(r.seller_id) ?? { sellerId: r.seller_id, name: name.get(r.seller_id) ?? "Usuario retirado", documents: 0, base: "", commission: "", lines: [], b: D(0), c: D(0) };
      s.documents++; s.b = s.b.plus(base); s.c = s.c.plus(commission);
      s.lines.push({ id: r.id, label: `${r.series}-${r.number}`, date: r.issue_date.toISOString().slice(0, 10), base: base.toFixed(2), percent: pct.toFixed(2), commission: commission.toFixed(2), isNote: sign < 0 });
      map.set(r.seller_id, s);
      totalBase = totalBase.plus(base); totalCommission = totalCommission.plus(commission);
    }
    const sellers = [...map.values()].map(({ b, c, ...s }) => ({ ...s, base: b.toFixed(2), commission: c.toFixed(2) })).sort((a, b) => Number(b.commission) - Number(a.commission));
    return { sellers, totalBase: totalBase.toFixed(2), totalCommission: totalCommission.toFixed(2) };
  });
}

export const rateSchema = z.object({
  userId: z.uuid(),
  percent: z.union([z.number(), z.string()]).transform((v) => D(String(v).replace(",", ".") || "0")).refine((d) => d.gte(0) && d.lte(100), "El porcentaje debe estar entre 0 y 100"),
});

export async function saveCommissionRate(ctx: TenantDbContext, raw: z.input<typeof rateSchema>): Promise<void> {
  const i = rateSchema.parse(raw);
  await withTenant(ctx, async (tx) => {
    const member = await tx.tenantUser.findFirst({ where: { user_id: i.userId, deleted_at: null } });
    if (!member) throw new DomainError("NOT_FOUND", "El usuario no pertenece a este negocio.");
    const before = await tx.sellerCommissionRate.findUnique({ where: { tenant_id_user_id: { tenant_id: ctx.tenantId, user_id: i.userId } } });
    await tx.sellerCommissionRate.upsert({
      where: { tenant_id_user_id: { tenant_id: ctx.tenantId, user_id: i.userId } },
      create: { tenant_id: ctx.tenantId, user_id: i.userId, percent: i.percent.toFixed(2) },
      update: { percent: i.percent.toFixed(2) },
    });
    await audit(tx, {
      tenantId: ctx.tenantId, actorUserId: ctx.userId, actorKind: "tenant_user", action: "commission.rate",
      entityType: "user", entityId: i.userId, before: { percent: before?.percent.toFixed(2) ?? null }, after: { percent: i.percent.toFixed(2) },
    });
  });
}
