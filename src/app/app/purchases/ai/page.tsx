import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { requireTenant } from "@/lib/auth/session";
import { withTenant } from "@/lib/db";
import { env } from "@/lib/env";
import { signedUrl } from "@/lib/storage";
import type { ExtractedInvoice } from "@/lib/ai/ingestion/schema";
import { EmptyState, PageHeader, Panel } from "../../_components/ui";
import { Uploader } from "./_components/uploader";
import { Review, type ReviewItem, type ReviewJob } from "./_components/review";

export const metadata = { title: "Cargar factura con IA" };
export const maxDuration = 60;

const STATUS: Record<string, [string, string]> = {
  UPLOADED: ["Subida", "gray"], PROCESSING: ["Procesando", "amber"], NEEDS_REVIEW: ["Por revisar", "blue"],
  APPROVED: ["Aprobada", "green"], COMMITTED: ["Registrada", "green"], FAILED: ["Error", "red"], DUPLICATE: ["Duplicada", "gray"],
};
const SOURCE: Record<string, string> = { IMAGE: "Foto", PDF: "PDF", XML: "XML" };
const DOC_CODE: Record<string, "01" | "03" | "09"> = { FACTURA: "01", BOLETA: "03", GUIA_REMISION: "09" };

export default async function AiPurchasePage({ searchParams }: { searchParams: Promise<{ job?: string }> }) {
  const ctx = await requireTenant({ permission: "purchases.ai_ingest", module: "AI_INVENTORY" });
  const { job: jobId } = await searchParams;
  const db = { tenantId: ctx.tenantId, userId: ctx.userId };

  if (jobId) {
    if (!z.uuid().safeParse(jobId).success) notFound();
    const data = await withTenant(db, async (tx) => {
      const job = await tx.aiIngestionJob.findFirst({ where: { id: jobId }, include: { items: { orderBy: { line_no: "asc" } } } });
      if (!job) return null;
      const products = await tx.product.findMany({
        where: { deleted_at: null, is_active: true }, orderBy: { name: "asc" }, take: 3000,
        select: { id: true, name: true, sku: true, units_per_package: true },
      });
      return { job, products };
    });
    if (!data) notFound();
    const { job } = data;
    const ex = (job.extracted ?? null) as ExtractedInvoice | null;
    const review: ReviewJob = {
      id: job.id, status: job.status, sourceKind: job.source_kind, error: job.error, warnings: job.warnings,
      confidence: job.overall_confidence ? Number(job.overall_confidence) : null,
      previewUrl: job.source_kind === "XML" ? null : await signedUrl("ai-ingestion", job.storage_path, 900).catch(() => null),
      purchaseId: job.purchase_id, duplicateOfPurchaseId: job.duplicate_of_purchase_id,
      header: {
        supplierRuc: ex?.supplier.ruc ?? "", supplierName: ex?.supplier.legal_name ?? "",
        docType: DOC_CODE[ex?.document_type ?? "FACTURA"] ?? "01", series: ex?.series ?? "", number: ex?.number ?? "",
        issueDate: ex?.issue_date ?? new Date().toISOString().slice(0, 10), currency: ex?.currency ?? "PEN",
      },
    };
    const items: ReviewItem[] = job.items.map((it) => ({
      id: it.id, lineNo: it.line_no, description: it.description, quantity: it.quantity.toString(), unitCode: it.unit_code,
      unitPrice: it.unit_price.toString(), igvIncluded: it.igv_included, lotCode: it.lot_code,
      expiryDate: it.expiry_date?.toISOString().slice(0, 10) ?? null, confidence: Number(it.confidence),
      matchedProductId: it.matched_product_id, matchMethod: it.match_method,
      candidates: ((it.candidates ?? []) as { productId: string; name: string; score: number }[]),
      unitsPerPackage: it.units_per_package, status: it.status,
    }));
    return (
      <>
        <PageHeader title="Revisar factura" subtitle="Verifique los datos leídos antes de ingresarlos al inventario"
          actions={<Link href="/app/purchases/ai" className="app-btn">← Volver</Link>} />
        <Review job={review} items={items}
          products={data.products.map((p) => ({ id: p.id, name: p.name, sku: p.sku, unitsPerPackage: p.units_per_package }))} />
      </>
    );
  }

  const { branch, jobs } = await withTenant(db, async (tx) => ({
    branch: await tx.branch.findFirst({
      where: { is_active: true, deleted_at: null, ...(ctx.branchIds.length ? { id: { in: ctx.branchIds } } : {}) },
      orderBy: { sunat_code: "asc" },
    }),
    jobs: await tx.aiIngestionJob.findMany({ orderBy: { created_at: "desc" }, take: 15 }),
  }));

  return (
    <>
      <PageHeader title="Cargar factura con IA" subtitle="Suba la factura de su proveedor: leemos productos, cantidades, costos, lotes y vencimientos" />
      {branch ? <Uploader branchId={branch.id} aiEnabled={!!env().ANTHROPIC_API_KEY} /> : (
        <Panel><EmptyState icon="truck" title="Sin sucursal activa" text="Configure una sucursal antes de cargar compras." /></Panel>
      )}
      <ol className="ai-steps">
        <li><strong>1. Suba</strong> la foto, PDF o XML de la factura.</li>
        <li><strong>2. Revise</strong> lo leído: producto, cantidad, costo, lote y vencimiento.</li>
        <li><strong>3. Registre</strong> la compra: el stock ingresa por lote con su kardex.</li>
      </ol>
      <Panel title="Cargas recientes">
        {jobs.length === 0 ? <p className="app-muted set-pad">Aún no hay cargas.</p> : (
          <div className="app-table-wrap"><table className="app-table stack">
            <thead><tr><th>Fecha</th><th>Origen</th><th>Estado</th><th>Detalle</th><th aria-label="Acción" /></tr></thead>
            <tbody>{jobs.map((j) => {
              const [label, tone] = STATUS[j.status] ?? [j.status, "gray"];
              const ex = j.extracted as ExtractedInvoice | null;
              return (
                <tr key={j.id}>
                  <td data-label="Fecha">{j.created_at.toLocaleString("es-PE", { timeZone: "America/Lima", dateStyle: "short", timeStyle: "short" })}</td>
                  <td data-label="Origen">{SOURCE[j.source_kind]}</td>
                  <td data-label="Estado"><span className={`app-pill ${tone}`}>{label}</span></td>
                  <td data-label="Detalle">{ex?.supplier.legal_name ? `${ex.supplier.legal_name} · ${ex.series ?? ""}-${ex.number ?? ""}` : (j.error ?? "—")}</td>
                  <td data-label=""><Link href={`/app/purchases/ai?job=${j.id}`} className="app-link">{j.status === "NEEDS_REVIEW" ? "Revisar" : "Ver"}</Link></td>
                </tr>
              );
            })}</tbody>
          </table></div>
        )}
      </Panel>
    </>
  );
}
