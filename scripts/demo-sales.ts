/**
 * Genera ventas de demostración para el tenant 'demo' usando el MISMO flujo del POS (createSale):
 * descuento FEFO por lote, kardex, correlativos y validaciones SUNAT reales.
 *
 *   node --env-file=.env.local --conditions=react-server --import tsx scripts/demo-sales.ts
 *
 * Las ventas de días anteriores se fechan simulando el reloj (issue_date); created_at queda con la hora real.
 * Los eventos de envío a SUNAT de estas ventas se eliminan: el demo no tiene certificado digital y los
 * comprobantes quedan en estado "Pendiente" (no se envían).
 */
import { randomUUID } from "node:crypto";
import { platformDb, runtimeDb } from "@/lib/db";
import { createSale, type CreateSaleInput } from "@/lib/inventory/pos";

type Item = { sku: string; qty: number; unit?: "UNIT" | "PACKAGE" };
type Sale = { daysAgo: number; hour: number; docType: "BOLETA" | "FACTURA"; customer?: CreateSaleInput["customer"]; items: Item[]; method: "EFECTIVO" | "YAPE" | "PLIN" | "TARJETA" | "TRANSFERENCIA" };

const ANON = { docType: "NO_DOC" as const, docNumber: "-", name: "CLIENTES VARIOS" };
const SALES: Sale[] = [
  { daysAgo: 6, hour: 10, docType: "BOLETA", items: [{ sku: "DESP-TAB", qty: 4 }, { sku: "SHAM-250", qty: 1 }], method: "EFECTIVO" },
  { daysAgo: 4, hour: 16, docType: "FACTURA", customer: { docType: "RUC", docNumber: "20000000010", name: "COMERCIAL GANADERA DEMO S.A.C.", address: "Jr. Las Praderas 456, Lima" }, items: [{ sku: "IVER-500", qty: 3 }, { sku: "JER-5", qty: 40 }], method: "TRANSFERENCIA" },
  { daysAgo: 2, hour: 11, docType: "BOLETA", items: [{ sku: "PARA-500", qty: 1, unit: "PACKAGE" }, { sku: "PANA-500", qty: 20 }], method: "YAPE" },
  { daysAgo: 1, hour: 18, docType: "BOLETA", customer: { docType: "DNI", docNumber: "41237896", name: "Jorge Huamán Ríos" }, items: [{ sku: "VAC-RAB", qty: 2 }, { sku: "DESP-TAB", qty: 2 }], method: "TARJETA" },
  { daysAgo: 0, hour: 9, docType: "BOLETA", items: [{ sku: "IVER-500", qty: 1 }, { sku: "JER-5", qty: 10 }], method: "EFECTIVO" },
  { daysAgo: 0, hour: 12, docType: "BOLETA", customer: { docType: "DNI", docNumber: "45678912", name: "Rosa Mamani Flores" }, items: [{ sku: "SHAM-250", qty: 1 }, { sku: "PARA-500", qty: 12 }], method: "YAPE" },
  { daysAgo: 0, hour: 15, docType: "FACTURA", customer: { docType: "RUC", docNumber: "20000000010", name: "COMERCIAL GANADERA DEMO S.A.C.", address: "Jr. Las Praderas 456, Lima" }, items: [{ sku: "ALIM-40", qty: 1 }, { sku: "MAIZ-1", qty: 5 }], method: "TRANSFERENCIA" },
];

/** Ejecuta fn con el reloj de JS fijado en `at` (solo para fechar comprobantes de días previos). */
async function atTime<T>(at: Date, fn: () => Promise<T>): Promise<T> {
  const Real = Date;
  const fixed = at.getTime();
  class FakeDate extends Real {
    constructor(...args: ConstructorParameters<typeof Date> | []) {
      if (args.length === 0) super(fixed);
      else super(...(args as ConstructorParameters<typeof Date>));
    }
    static override now() { return fixed; }
  }
  globalThis.Date = FakeDate as DateConstructor;
  try { return await fn(); } finally { globalThis.Date = Real; }
}

async function main() {
  const db = platformDb();
  const tenant = await db.tenant.findUniqueOrThrow({ where: { slug: "demo" } });
  const admin = await db.tenantUser.findFirstOrThrow({ where: { tenant_id: tenant.id, role: { key: "admin" }, status: "ACTIVE" } });
  const branch = await db.branch.findFirstOrThrow({ where: { tenant_id: tenant.id, sunat_code: "0000" } });
  const series = await db.documentSeries.findMany({ where: { tenant_id: tenant.id, branch_id: branch.id, is_active: true } });
  const products = await db.product.findMany({ where: { tenant_id: tenant.id, deleted_at: null } });
  const bySku = new Map(products.map((p) => [p.sku, p]));
  const ctx = { tenantId: tenant.id, userId: admin.user_id };

  // "Hoy" en Lima (UTC-5): las ventas de hoy no pueden quedar en el futuro
  const nowLima = new Date(Date.now() - 5 * 3_600_000);
  const created: string[] = [];
  for (const s of SALES) {
    const day = new Date(Date.UTC(nowLima.getUTCFullYear(), nowLima.getUTCMonth(), nowLima.getUTCDate() - s.daysAgo, s.hour + 5, 7));
    const at = s.daysAgo === 0 && day.getTime() > Date.now() ? new Date(Date.now() - 60_000) : day;
    const items = s.items.map((i) => {
      const p = bySku.get(i.sku);
      if (!p) throw new Error(`Producto ${i.sku} no existe: ejecute prisma/demo-seed.sql primero`);
      return { productId: p.id, quantity: i.qty, saleUnit: i.unit ?? "UNIT" };
    });
    // total para cuadrar el pago: suma de precios (IGV incluido)
    const total = s.items.reduce((acc, i) => {
      const p = bySku.get(i.sku)!;
      const price = i.unit === "PACKAGE" ? Number(p.package_price ?? Number(p.sale_price) * p.units_per_package) : Number(p.sale_price);
      return acc + Math.round(price * i.qty * 100) / 100;
    }, 0);
    const res = await atTime(at, () =>
      createSale(ctx, {
        idempotencyKey: randomUUID(),
        branchId: branch.id,
        docType: s.docType,
        series: series.find((x) => x.doc_type === s.docType)!.series,
        customer: s.customer ?? ANON,
        items,
        payments: [{ method: s.method, amount: total.toFixed(2) }],
      }, { canOverridePrice: true, canDispenseRx: false, pharmacyEnabled: true }),
    );
    created.push(res.documentId);
    console.log(`${res.issueDate}  ${res.series}-${res.number}  S/ ${res.total}`);
  }

  const removed = await db.outboxEvent.deleteMany({ where: { aggregate_id: { in: created }, event_type: "document.issued" } });
  console.log(`Ventas creadas: ${created.length} · eventos SUNAT descartados: ${removed.count}`);
  await Promise.all([db.$disconnect(), runtimeDb().$disconnect()]);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
