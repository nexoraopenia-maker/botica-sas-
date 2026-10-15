import "server-only";
import { createHash } from "node:crypto";
import { platformDb, withTenantAsSystem, Prisma } from "@/lib/db";
import { D } from "@/lib/money";
import { getObject } from "@/lib/storage";
import { limaNow, limaPeriod } from "@/lib/time";
import { extractInvoice } from "@/lib/ai/ingestion/extract";
import { parseSupplierUbl } from "@/lib/ai/ingestion/xml-ubl";
import { LOW_CONFIDENCE, sanityCheck } from "@/lib/ai/ingestion/sanity";
import { embedDescriptions, matchItem } from "@/lib/ai/ingestion/match";
import type { ExtractedInvoice } from "@/lib/ai/ingestion/schema";
import type { HandlerResult } from "@/lib/sunat/emit";

export const sha256 = (buf: Buffer): string => createHash("sha256").update(buf).digest("hex");

/** Paso asíncrono del pipeline: archivo → extracción → validación → emparejamiento → NEEDS_REVIEW. */
export async function processIngestionJob(jobId: string, attempt: number): Promise<HandlerResult> {
  const db = platformDb();
  const job = await db.aiIngestionJob.findUnique({ where: { id: jobId } });
  if (!job) return { status: "dead", error: "Job inexistente" };
  if (!["UPLOADED", "PROCESSING", "FAILED"].includes(job.status)) return { status: "done" };

  const tenant = await db.tenant.findUniqueOrThrow({ where: { id: job.tenant_id } });
  await db.aiIngestionJob.update({ where: { id: job.id }, data: { status: "PROCESSING", attempts: { increment: 1 } } });

  const file = await getObject("ai-ingestion", job.storage_path);
  let extracted: ExtractedInvoice;
  let usage = { model: "xml-ubl", inputTokens: 0, outputTokens: 0 };

  if (job.source_kind === "XML") {
    try {
      extracted = parseSupplierUbl(file.toString("utf8"));
    } catch (err) {
      await db.aiIngestionJob.update({ where: { id: job.id }, data: { status: "FAILED", error: (err as Error).message } });
      return { status: "done" };
    }
  } else {
    const res = await extractInvoice(file, job.mime_type, {
      tenantRuc: tenant.ruc,
      tenantName: tenant.trade_name ?? tenant.legal_name,
      businessLines: tenant.business_lines,
    });
    if (!res.ok) {
      const final = !res.retryable || attempt >= 4;
      await db.aiIngestionJob.update({ where: { id: job.id }, data: { status: final ? "FAILED" : "PROCESSING", error: res.error } });
      return final ? { status: "done" } : { status: "retry", delayMs: 60_000 * attempt, error: res.error };
    }
    extracted = res.data;
    usage = { model: res.model, inputTokens: res.inputTokens, outputTokens: res.outputTokens };
  }

  const warnings = [...extracted.warnings, ...sanityCheck(extracted, tenant.ruc, limaNow().dateObj)];
  const vectors = await embedDescriptions(extracted.items.map((i) => i.description));

  await withTenantAsSystem(job.tenant_id, async (tx) => {
    // Duplicados: mismo proveedor + serie + número ya registrado
    const supplier = extracted.supplier.ruc
      ? await tx.supplier.findFirst({ where: { tenant_id: job.tenant_id, ruc: extracted.supplier.ruc, deleted_at: null } })
      : null;
    if (supplier && extracted.series && extracted.number) {
      const dup = await tx.purchase.findFirst({
        where: { tenant_id: job.tenant_id, supplier_id: supplier.id, series: extracted.series, number: extracted.number, deleted_at: null },
      });
      if (dup) {
        await tx.aiIngestionJob.update({
          where: { id: job.id },
          data: {
            status: "DUPLICATE", duplicate_of_purchase_id: dup.id, extracted: extracted as unknown as Prisma.InputJsonValue,
            warnings: [...warnings, `Comprobante ya registrado como compra ${dup.series}-${dup.number}.`],
          },
        });
        return;
      }
    }

    await tx.aiIngestionItem.deleteMany({ where: { job_id: job.id } }); // reintento idempotente
    for (const [idx, it] of extracted.items.entries()) {
      const m = await matchItem(tx, { description: it.description, supplierCode: it.supplier_code }, supplier?.id ?? null, vectors[idx] ?? null);
      const lowConfidence = it.confidence < LOW_CONFIDENCE;
      await tx.aiIngestionItem.create({
        data: {
          tenant_id: job.tenant_id,
          job_id: job.id,
          line_no: idx + 1,
          raw: it as unknown as Prisma.InputJsonValue,
          supplier_code: it.supplier_code,
          description: it.description,
          quantity: D(it.quantity),
          unit_code: it.unit,
          unit_price: D(it.unit_price),
          igv_included: it.unit_price_includes_igv,
          line_total: it.line_total ? D(it.line_total) : null,
          lot_code: it.lot_code,
          expiry_date: it.expiry_date ? new Date(`${it.expiry_date}T00:00:00Z`) : null,
          confidence: it.confidence,
          matched_product_id: m.best?.productId ?? null,
          match_method: m.best?.method ?? "NONE",
          match_score: m.best?.score ?? null,
          candidates: m.candidates as unknown as Prisma.InputJsonValue,
          units_per_package: it.units_per_package,
          // Baja confianza de lectura nunca se auto-aprueba, aunque el match sea perfecto
          status: lowConfidence && m.status === "MATCHED" ? "NEEDS_REVIEW" : m.status,
        },
      });
    }

    await tx.aiIngestionJob.update({
      where: { id: job.id },
      data: {
        status: "NEEDS_REVIEW",
        model: usage.model,
        extracted: extracted as unknown as Prisma.InputJsonValue,
        overall_confidence: extracted.overall_confidence,
        warnings,
        supplier_id: supplier?.id ?? null,
        input_tokens: usage.inputTokens,
        output_tokens: usage.outputTokens,
        error: null,
      },
    });

    const period = limaPeriod();
    for (const [metric, value] of [["ai_pages", 1], ["ai_input_tokens", usage.inputTokens], ["ai_output_tokens", usage.outputTokens]] as const) {
      await tx.$executeRaw`
        INSERT INTO usage_counters (tenant_id, period, metric, value) VALUES (${job.tenant_id}::uuid, ${period}, ${metric}, ${value})
        ON CONFLICT (tenant_id, period, metric) DO UPDATE SET value = usage_counters.value + EXCLUDED.value`;
    }
  });

  return { status: "done" };
}
