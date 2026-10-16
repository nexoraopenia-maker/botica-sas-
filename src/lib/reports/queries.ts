import "server-only";
import { withTenant, type TenantDbContext } from "@/lib/db";

export interface ReportData {
  days: number;
  from: string;
  to: string;
  kpis: {
    salesGross: number;      // ventas con IGV (facturas + boletas)
    salesNet: number;        // valor de venta sin IGV
    cost: number;            // costo de lo vendido (costo del lote consumido)
    margin: number;          // salesNet - cost
    marginPct: number | null;
    docs: number;
    avgTicket: number | null;
    creditNotes: number;     // total de notas de crédito del periodo
  };
  daily: { date: string; total: number; docs: number }[];
  byMethod: { method: string; total: number; count: number }[];
  topProducts: { name: string; sku: string; qty: number; net: number; cost: number; margin: number; marginPct: number | null }[];
  inventory: {
    valueTotal: number;
    valueExpiring60: number;
    valueExpired: number;
    lowStock: number;
    top: { name: string; sku: string; stock: number; value: number; nearestExpiry: string | null }[];
  };
}

const n = (v: unknown): number => Number(v ?? 0);

/**
 * Reportes del periodo (últimos N días en hora de Lima). Ventas = facturas + boletas no rechazadas ni anuladas.
 * El costo sale de los lotes efectivamente descontados (document_item_lots), así el margen es real por FEFO.
 */
export async function loadReports(ctx: TenantDbContext, days: number): Promise<ReportData> {
  return withTenant(ctx, async (tx) => {
    const range = await tx.$queryRaw<{ from: Date; to: Date }[]>`
      SELECT (app.lima_today() - ${days - 1}::int) AS "from", app.lima_today() AS "to"`;
    const { from, to } = range[0]!;

    const [kpi] = await tx.$queryRaw<Record<string, unknown>[]>`
      WITH d AS (
        SELECT id, total, op_gravadas + op_exoneradas + op_inafectas AS net
          FROM documents
         WHERE doc_type IN ('FACTURA', 'BOLETA') AND status NOT IN ('RECHAZADO', 'ANULADO') AND deleted_at IS NULL
           AND issue_date BETWEEN ${from}::date AND ${to}::date
      )
      SELECT coalesce(sum(d.total), 0) AS gross, coalesce(sum(d.net), 0) AS net, count(*) AS docs,
             coalesce((SELECT sum(l.quantity * l.unit_cost) FROM document_items i JOIN document_item_lots l ON l.document_item_id = i.id
                        WHERE i.document_id IN (SELECT id FROM d)), 0) AS cost,
             coalesce((SELECT sum(total) FROM documents WHERE doc_type = 'NOTA_CREDITO' AND status <> 'RECHAZADO'
                        AND issue_date BETWEEN ${from}::date AND ${to}::date), 0) AS credit_notes
        FROM d`;

    const daily = await tx.$queryRaw<{ date: string; total: unknown; docs: unknown }[]>`
      SELECT to_char(g.day, 'YYYY-MM-DD') AS date, coalesce(sum(d.total), 0) AS total, count(d.id) AS docs
        FROM generate_series(${from}::date, ${to}::date, interval '1 day') AS g(day)
        LEFT JOIN documents d ON d.issue_date = g.day::date AND d.doc_type IN ('FACTURA', 'BOLETA')
             AND d.status NOT IN ('RECHAZADO', 'ANULADO') AND d.deleted_at IS NULL
       GROUP BY g.day ORDER BY g.day`;

    const byMethod = await tx.$queryRaw<{ method: string; total: unknown; count: unknown }[]>`
      SELECT p.method::text AS method, sum(p.amount) AS total, count(DISTINCT p.document_id) AS count
        FROM document_payments p JOIN documents d ON d.id = p.document_id
       WHERE d.doc_type IN ('FACTURA', 'BOLETA') AND d.status NOT IN ('RECHAZADO', 'ANULADO')
         AND d.issue_date BETWEEN ${from}::date AND ${to}::date
       GROUP BY p.method ORDER BY sum(p.amount) DESC`;

    const topProducts = await tx.$queryRaw<Record<string, unknown>[]>`
      SELECT coalesce(p.name, i.description) AS name, coalesce(p.sku, '') AS sku,
             sum(i.base_quantity) AS qty, sum(i.line_extension) AS net,
             coalesce(sum((SELECT sum(l.quantity * l.unit_cost) FROM document_item_lots l WHERE l.document_item_id = i.id)), 0) AS cost
        FROM document_items i
        JOIN documents d ON d.id = i.document_id
        LEFT JOIN products p ON p.id = i.product_id
       WHERE d.doc_type IN ('FACTURA', 'BOLETA') AND d.status NOT IN ('RECHAZADO', 'ANULADO')
         AND d.issue_date BETWEEN ${from}::date AND ${to}::date
       GROUP BY coalesce(p.name, i.description), coalesce(p.sku, '')
       ORDER BY sum(i.line_extension) DESC
       LIMIT 10`;

    const [inv] = await tx.$queryRaw<Record<string, unknown>[]>`
      SELECT coalesce(sum(b.stock * b.unit_cost), 0) AS total,
             coalesce(sum(b.stock * b.unit_cost) FILTER (WHERE b.expiry_date BETWEEN app.lima_today() AND app.lima_today() + 60), 0) AS expiring,
             coalesce(sum(b.stock * b.unit_cost) FILTER (WHERE b.expiry_date < app.lima_today()), 0) AS expired
        FROM product_batches b WHERE b.stock > 0 AND b.deleted_at IS NULL`;

    const [low] = await tx.$queryRaw<{ c: unknown }[]>`
      SELECT count(*) AS c FROM (
        SELECT p.id FROM products p LEFT JOIN product_batches b ON b.product_id = p.id AND b.deleted_at IS NULL
         WHERE p.deleted_at IS NULL AND p.is_active AND p.min_stock > 0
         GROUP BY p.id, p.min_stock
        HAVING coalesce(sum(b.stock) FILTER (WHERE b.expiry_date IS NULL OR b.expiry_date >= app.lima_today()), 0) <= p.min_stock
      ) x`;

    const invTop = await tx.$queryRaw<Record<string, unknown>[]>`
      SELECT p.name, p.sku, sum(b.stock) AS stock, sum(b.stock * b.unit_cost) AS value,
             to_char(min(b.expiry_date) FILTER (WHERE b.expiry_date >= app.lima_today()), 'YYYY-MM-DD') AS nearest
        FROM product_batches b JOIN products p ON p.id = b.product_id
       WHERE b.stock > 0 AND b.deleted_at IS NULL
       GROUP BY p.id ORDER BY sum(b.stock * b.unit_cost) DESC LIMIT 10`;

    const salesNet = n(kpi!.net);
    const cost = n(kpi!.cost);
    const docs = n(kpi!.docs);
    return {
      days,
      from: from.toISOString().slice(0, 10),
      to: to.toISOString().slice(0, 10),
      kpis: {
        salesGross: n(kpi!.gross), salesNet, cost, margin: salesNet - cost,
        marginPct: salesNet > 0 ? (salesNet - cost) / salesNet : null,
        docs, avgTicket: docs ? n(kpi!.gross) / docs : null, creditNotes: n(kpi!.credit_notes),
      },
      daily: daily.map((r) => ({ date: r.date, total: n(r.total), docs: n(r.docs) })),
      byMethod: byMethod.map((r) => ({ method: r.method, total: n(r.total), count: n(r.count) })),
      topProducts: topProducts.map((r) => {
        const net = n(r.net), c = n(r.cost);
        return { name: String(r.name), sku: String(r.sku), qty: n(r.qty), net, cost: c, margin: net - c, marginPct: net > 0 ? (net - c) / net : null };
      }),
      inventory: {
        valueTotal: n(inv!.total), valueExpiring60: n(inv!.expiring), valueExpired: n(inv!.expired), lowStock: n(low!.c),
        top: invTop.map((r) => ({ name: String(r.name), sku: String(r.sku), stock: n(r.stock), value: n(r.value), nearestExpiry: (r.nearest as string | null) ?? null })),
      },
    };
  });
}
