import "server-only";
import { z } from "zod";
import { withTenant, Prisma, type TenantDbContext } from "@/lib/db";
import { D, round2 } from "@/lib/money";
import { DomainError } from "@/lib/result";
import { audit } from "@/lib/audit";
import { isValidRuc } from "@/lib/sunat/validation";

const dec = z.union([z.number(), z.string()]).transform((v) => D(v));

export const approveIngestionSchema = z.object({
  jobId: z.uuid(),
  supplier: z.object({ ruc: z.string().refine(isValidRuc, "RUC inválido"), legalName: z.string().min(2) }),
  header: z.object({
    docType: z.enum(["01", "03", "09"]),
    series: z.string().min(1).max(4),
    number: z.string().min(1).max(10),
    issueDate: z.iso.date(),
    currency: z.enum(["PEN", "USD"]),
    exchangeRate: dec.optional(),
  }),
  items: z
    .array(
      z.object({
        itemId: z.uuid(),
        action: z.enum(["RECEIVE", "IGNORE"]),
        productId: z.uuid().optional(),
        newProduct: z
          .object({
            name: z.string().min(2),
            sku: z.string().min(1),
            unitCode: z.string().default("NIU"),
            salePrice: dec,
            unitsPerPackage: z.number().int().min(1).default(1),
            igvAffectation: z.enum(["10", "20", "30"]).default("10"),
          })
          .optional(),
        quantity: dec,
        purchaseUnit: z.enum(["UNIT", "PACKAGE"]),
        unitsPerPackage: z.number().int().min(1).default(1),
        unitCostWithoutIgv: dec,
        lotCode: z.string().max(40).optional(),
        expiryDate: z.iso.date().optional(),
      }),
    )
    .min(1),
});

/**
 * Revisión humana aprobada → compra + lotes + kardex, en UNA transacción.
 * Las correcciones del revisor quedan en purchase_items y alimentan el
 * emparejamiento por historial en próximas cargas del mismo proveedor.
 */
export async function approveIngestion(ctx: TenantDbContext, raw: z.input<typeof approveIngestionSchema>): Promise<{ purchaseId: string }> {
  const input = approveIngestionSchema.parse(raw);
  const toReceive = input.items.filter((i) => i.action === "RECEIVE");
  if (!toReceive.length) throw new DomainError("EMPTY", "No hay líneas para recibir.");
  for (const it of toReceive) {
    if (!it.productId && !it.newProduct) throw new DomainError("UNMATCHED", "Todas las líneas deben tener producto asignado.");
  }

  try {
    return await withTenant(ctx, async (tx) => {
      const job = await tx.aiIngestionJob.findFirst({ where: { id: input.jobId } });
      if (!job) throw new DomainError("NOT_FOUND", "Carga no encontrada.");
      if (job.status !== "NEEDS_REVIEW") throw new DomainError("INVALID_STATE", `La carga está en estado ${job.status}.`);

      const [supplier] = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO suppliers (tenant_id, ruc, legal_name) VALUES (${ctx.tenantId}::uuid, ${input.supplier.ruc}, ${input.supplier.legalName})
        ON CONFLICT (tenant_id, ruc) WHERE deleted_at IS NULL DO UPDATE SET legal_name = EXCLUDED.legal_name
        RETURNING id`;

      const fx = input.header.currency === "USD" ? (input.header.exchangeRate ?? null) : D(1);
      if (!fx) throw new DomainError("FX_REQUIRED", "Indique el tipo de cambio para compras en USD.");

      const lines = toReceive.map((it) => {
        const factor = it.purchaseUnit === "PACKAGE" ? it.unitsPerPackage : 1;
        const baseQty = it.quantity.times(factor);
        const lineTotal = round2(it.quantity.times(it.unitCostWithoutIgv));
        const baseCostPen = it.unitCostWithoutIgv.times(fx).div(factor).toDecimalPlaces(6);
        return { it, baseQty, lineTotal, baseCostPen };
      });
      const subtotal = lines.reduce((a, l) => a.plus(l.lineTotal), D(0));
      const igv = round2(subtotal.times("0.18"));

      const purchase = await tx.purchase.create({
        data: {
          tenant_id: ctx.tenantId,
          branch_id: job.branch_id,
          supplier_id: supplier!.id,
          doc_type: input.header.docType,
          series: input.header.series,
          number: input.header.number,
          issue_date: new Date(`${input.header.issueDate}T00:00:00Z`),
          currency: input.header.currency,
          exchange_rate: input.header.currency === "USD" ? fx : null,
          subtotal,
          igv,
          total: subtotal.plus(igv),
          status: "RECEIVED",
          source: job.source_kind === "XML" ? "XML_UBL" : job.source_kind === "PDF" ? "AI_PDF" : "AI_IMAGE",
          ai_job_id: job.id,
          attachment_path: job.storage_path,
          received_at: new Date(),
          created_by: ctx.userId,
        },
      });

      for (const l of lines) {
        let productId = l.it.productId;
        if (!productId && l.it.newProduct) {
          const np = l.it.newProduct;
          const created = await tx.product.create({
            data: {
              tenant_id: ctx.tenantId, sku: np.sku, name: np.name, unit_code: np.unitCode, sale_price: np.salePrice,
              units_per_package: np.unitsPerPackage, igv_affectation: np.igvAffectation,
            },
          });
          productId = created.id;
        }
        const pi = await tx.purchaseItem.create({
          data: {
            tenant_id: ctx.tenantId, purchase_id: purchase.id, product_id: productId!,
            description: (await tx.aiIngestionItem.findUnique({ where: { id: l.it.itemId }, select: { description: true } }))?.description ?? "",
            quantity: l.it.quantity, purchase_unit: l.it.purchaseUnit, base_quantity: l.baseQty,
            unit_cost: l.it.unitCostWithoutIgv, line_total: l.lineTotal,
            lot_code: l.it.lotCode ?? null,
            expiry_date: l.it.expiryDate ? new Date(`${l.it.expiryDate}T00:00:00Z`) : null,
          },
        });
        const [{ id: batchId }] = await tx.$queryRaw<[{ id: string }]>`
          SELECT app.receive_batch(${ctx.tenantId}::uuid, ${job.branch_id}::uuid, ${productId}::uuid, ${l.it.lotCode ?? null},
                                   ${l.it.expiryDate ?? null}::date, ${l.baseQty}::numeric, ${l.baseCostPen}::numeric,
                                   ${pi.id}::uuid, ${ctx.userId}::uuid) AS id`;
        await tx.purchaseItem.update({ where: { id: pi.id }, data: { batch_id: batchId } });

        const product = await tx.product.findUniqueOrThrow({ where: { id: productId! }, select: { is_controlled: true } });
        if (product.is_controlled) {
          await tx.controlledSubstanceLog.create({
            data: {
              tenant_id: ctx.tenantId, branch_id: job.branch_id, product_id: productId!, batch_id: batchId, movement: "IN",
              quantity: l.baseQty, balance: 0, purchase_id: purchase.id, counterparty: input.supplier.legalName, recorded_by: ctx.userId,
            },
          });
        }
        await tx.aiIngestionItem.update({
          where: { id: l.it.itemId },
          data: { matched_product_id: productId!, status: "MATCHED", match_method: l.it.productId ? undefined : "MANUAL" },
        });
      }
      await tx.aiIngestionItem.updateMany({
        where: { id: { in: input.items.filter((i) => i.action === "IGNORE").map((i) => i.itemId) } },
        data: { status: "IGNORED" },
      });

      await tx.aiIngestionJob.update({
        where: { id: job.id },
        data: { status: "COMMITTED", purchase_id: purchase.id, supplier_id: supplier!.id, reviewed_by: ctx.userId, reviewed_at: new Date() },
      });
      await audit(tx, {
        tenantId: ctx.tenantId, actorUserId: ctx.userId, actorKind: "tenant_user", action: "purchase.ai_commit",
        entityType: "purchase", entityId: purchase.id, after: { jobId: job.id, lines: lines.length, total: subtotal.plus(igv).toFixed(2) },
      });
      return { purchaseId: purchase.id };
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw new DomainError("DUPLICATE_PURCHASE", "Este comprobante de compra ya fue registrado.");
    }
    throw err;
  }
}
