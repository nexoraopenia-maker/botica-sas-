import "server-only";
import { withTenant, type TenantDbContext } from "@/lib/db";
import { audit } from "@/lib/audit";
import { D } from "@/lib/money";
import { DomainError } from "@/lib/result";
import { DOC_TYPE_CODE, IDENTITY_CODE } from "@/lib/sunat/catalogs";
import { pleFile, pleFileName, purchaseLine, saleLine, type PleBook } from "./ple-format";

export const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

const monthRange = (period: string) => {
  const [y, m] = period.split("-").map(Number) as [number, number];
  return { from: new Date(Date.UTC(y, m - 1, 1)), to: new Date(Date.UTC(y, m, 0)) };
};

export interface PleSummary {
  sales: { documents: number; total: string; notSent: number; rejected: number };
  purchases: { documents: number; total: string; excluded: number; missingRate: number };
}

/** Resumen para la pestaña: cuánto entra en cada libro y qué conviene revisar antes de presentarlo. */
export async function pleSummary(ctx: TenantDbContext, period: string): Promise<PleSummary> {
  const { from, to } = monthRange(period);
  return withTenant(ctx, async (tx) => {
    const docs = await tx.document.groupBy({
      by: ["status"], where: { issue_date: { gte: from, lte: to }, deleted_at: null }, _count: true, _sum: { total: true },
    });
    const included = docs.filter((d) => d.status !== "RECHAZADO");
    const purchases = await tx.purchase.findMany({
      where: { issue_date: { gte: from, lte: to }, status: "RECEIVED", deleted_at: null }, select: { doc_type: true, total: true, currency: true, exchange_rate: true },
    });
    const valid = purchases.filter((p) => ["01", "03"].includes(p.doc_type.trim()));
    return {
      sales: {
        documents: included.reduce((a, d) => a + d._count, 0),
        total: included.reduce((a, d) => a.plus(d.status === "ANULADO" ? 0 : (d._sum.total ?? 0)), D(0)).toFixed(2),
        notSent: docs.filter((d) => ["PENDIENTE", "ENVIANDO", "ERROR_REINTENTABLE"].includes(d.status)).reduce((a, d) => a + d._count, 0),
        rejected: docs.find((d) => d.status === "RECHAZADO")?._count ?? 0,
      },
      purchases: {
        documents: valid.length,
        total: valid.reduce((a, p) => a.plus(p.total), D(0)).toFixed(2),
        excluded: purchases.length - valid.length,
        missingRate: valid.filter((p) => p.currency !== "PEN" && !p.exchange_rate).length,
      },
    };
  });
}

/** Genera el TXT del periodo y deja constancia de quién lo exportó. Solo lectura de datos + auditoría. */
export async function buildPleFile(ctx: TenantDbContext, tenant: { ruc: string }, book: PleBook, period: string): Promise<{ fileName: string; content: Buffer; count: number }> {
  if (!PERIOD_RE.test(period)) throw new DomainError("VALIDATION", "Periodo inválido (AAAA-MM).");
  const { from, to } = monthRange(period);
  const lines = await withTenant(ctx, async (tx) => {
    let out: string[];
    if (book === "sales") {
      // Los RECHAZADOS por SUNAT no son comprobantes válidos: no se anotan
      const docs = await tx.document.findMany({
        where: { issue_date: { gte: from, lte: to }, deleted_at: null, status: { not: "RECHAZADO" } },
        include: { refDocument: { select: { issue_date: true, doc_type: true, series: true, number: true } } },
        orderBy: [{ issue_date: "asc" }, { series: "asc" }, { number: "asc" }],
      });
      out = docs.map((d, i) => saleLine({
        docCode: DOC_TYPE_CODE[d.doc_type], series: d.series, number: d.number, issueDate: d.issue_date,
        customerDocCode: IDENTITY_CODE[d.customer_doc_type], customerDoc: d.customer_doc_number, customerName: d.customer_name,
        gravada: d.op_gravadas, exonerada: d.op_exoneradas, inafecta: d.op_inafectas, igv: d.igv, icbper: d.icbper, total: d.total,
        voided: d.status === "ANULADO",
        ref: d.refDocument ? { date: d.refDocument.issue_date, docCode: DOC_TYPE_CODE[d.refDocument.doc_type], series: d.refDocument.series, number: d.refDocument.number } : null,
      }, period, i + 1));
    } else {
      const rows = await tx.purchase.findMany({
        where: { issue_date: { gte: from, lte: to }, status: "RECEIVED", deleted_at: null, doc_type: { in: ["01", "03"] } },
        include: { supplier: { select: { ruc: true, legal_name: true } }, items: { select: { igv_affectation: true, line_total: true } } },
        orderBy: [{ issue_date: "asc" }, { series: "asc" }, { number: "asc" }],
      });
      const noRate = rows.find((p) => p.currency !== "PEN" && !p.exchange_rate);
      if (noRate) throw new DomainError("MISSING_RATE", `La compra ${noRate.series}-${noRate.number} está en ${noRate.currency} y no tiene tipo de cambio.`);
      out = rows.map((p, i) => purchaseLine({
        docCode: p.doc_type.trim(), series: p.series, number: p.number, issueDate: p.issue_date,
        supplierRuc: p.supplier.ruc, supplierName: p.supplier.legal_name,
        nonTaxable: p.items.filter((it) => !it.igv_affectation.startsWith("1")).reduce((a, it) => a.plus(it.line_total), D(0)),
        subtotal: p.subtotal, igv: p.igv, total: p.total, currency: p.currency, exchangeRate: p.exchange_rate,
      }, period, i + 1));
    }
    await audit(tx, {
      tenantId: ctx.tenantId, actorUserId: ctx.userId, actorKind: "tenant_user", action: "ple.export",
      entityType: "tenant", entityId: ctx.tenantId, after: { book, period, operations: out.length },
    });
    return out;
  });
  return { fileName: pleFileName(tenant.ruc, period, book, lines.length > 0), content: pleFile(lines), count: lines.length };
}
