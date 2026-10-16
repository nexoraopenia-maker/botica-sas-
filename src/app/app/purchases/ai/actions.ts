"use server";

import { z } from "zod";
import { withTenant } from "@/lib/db";
import { requireTenant } from "@/lib/auth/session";
import { DomainError, ok, toActionError, type ActionResult } from "@/lib/result";
import { putObject, tenantPath } from "@/lib/storage";
import { limaPeriod } from "@/lib/time";
import { platformDb } from "@/lib/db";
import { processIngestionJob, sha256 } from "@/lib/ai/ingestion/process";
import { approveIngestion, type approveIngestionSchema } from "@/lib/ai/ingestion/commit";

const ALLOWED: Record<string, "IMAGE" | "PDF" | "XML"> = {
  "image/jpeg": "IMAGE", "image/png": "IMAGE", "image/webp": "IMAGE",
  "application/pdf": "PDF", "application/xml": "XML", "text/xml": "XML",
};
const MAX_BYTES = 10 * 1024 * 1024;

const uploadSchema = z.object({ branchId: z.uuid(), file: z.instanceof(File) });

/** Paso 1: subir foto/PDF/XML → Storage → job asíncrono (outbox "ai.ingest"). */
export async function uploadInvoiceAction(form: FormData): Promise<ActionResult<{ jobId: string; duplicate: boolean }>> {
  try {
    const { branchId, file } = uploadSchema.parse({ branchId: form.get("branchId"), file: form.get("file") });
    const ctx = await requireTenant({ permission: "purchases.ai_ingest", module: "AI_INVENTORY", mutation: true, branchId });
    const kind = ALLOWED[file.type];
    if (!kind) throw new DomainError("UNSUPPORTED_FILE", "Formato no soportado (JPG, PNG, WEBP, PDF o XML).");
    if (file.size > MAX_BYTES) throw new DomainError("FILE_TOO_LARGE", "El archivo supera 10 MB.");

    const buf = Buffer.from(await file.arrayBuffer());
    const hash = sha256(buf);
    const db = { tenantId: ctx.tenantId, userId: ctx.userId };

    // Límite del plan (páginas IA por mes)
    const usage = await withTenant(db, async (tx) => {
      const [sub, counter, dup] = await Promise.all([
        tx.subscription.findFirst({ where: { status: { in: ["ACTIVE", "TRIALING"] } }, include: { plan: true } }),
        tx.usageCounter.findUnique({ where: { tenant_id_period_metric: { tenant_id: ctx.tenantId, period: limaPeriod(), metric: "ai_pages" } } }),
        tx.aiIngestionJob.findFirst({ where: { file_sha256: hash } }),
      ]);
      return { limit: sub?.plan.max_ai_pages_month ?? 0, used: Number(counter?.value ?? 0), dup };
    });
    if (usage.dup) return ok({ jobId: usage.dup.id, duplicate: true });
    if (kind !== "XML" && usage.used >= usage.limit) {
      throw new DomainError("PLAN_LIMIT", "Alcanzó el límite mensual de cargas con IA de su plan.");
    }

    const path = tenantPath(ctx.tenantId, "invoices", `${hash}.${kind === "XML" ? "xml" : file.type.split("/")[1]}`);
    await putObject("ai-ingestion", path, buf, file.type);

    const jobId = await withTenant(db, async (tx) => {
      const job = await tx.aiIngestionJob.create({
        data: {
          tenant_id: ctx.tenantId, branch_id: branchId, storage_path: path, file_sha256: hash, mime_type: file.type,
          source_kind: kind, created_by: ctx.userId,
        },
      });
      await tx.outboxEvent.create({
        data: {
          tenant_id: ctx.tenantId, aggregate_type: "ai_ingestion_job", aggregate_id: job.id, event_type: "ai.ingest",
          payload: { jobId: job.id }, dedupe_key: `ai.ingest:${job.id}`, max_attempts: 5,
        },
      });
      return job.id;
    });
    return ok({ jobId, duplicate: false });
  } catch (e) {
    return toActionError(e);
  }
}

/** Paso final: revisión humana aprobada → compra, lotes y kardex. */
export async function approveIngestionAction(input: z.input<typeof approveIngestionSchema>): Promise<ActionResult<{ purchaseId: string }>> {
  try {
    const ctx = await requireTenant({ permission: "purchases.manage", module: "AI_INVENTORY", mutation: true });
    return ok(await approveIngestion({ tenantId: ctx.tenantId, userId: ctx.userId }, input));
  } catch (e) {
    return toActionError(e);
  }
}

/**
 * Procesa la carga en el momento (sin esperar al worker): extracción → validación → emparejamiento.
 * Idempotente por estado; el evento del outbox queda como respaldo si esta llamada se interrumpe.
 */
export async function runIngestionAction(jobId: string): Promise<ActionResult<{ status: string }>> {
  try {
    const id = z.uuid().parse(jobId);
    const ctx = await requireTenant({ permission: "purchases.ai_ingest", module: "AI_INVENTORY", mutation: true });
    const job = await withTenant({ tenantId: ctx.tenantId, userId: ctx.userId }, (tx) => tx.aiIngestionJob.findFirst({ where: { id } }));
    if (!job) throw new DomainError("NOT_FOUND", "Carga no encontrada.");
    try {
      await processIngestionJob(job.id, job.attempts + 1);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const friendly = msg.includes("ANTHROPIC_API_KEY")
        ? "El servicio de IA no está configurado (falta ANTHROPIC_API_KEY). Las facturas XML sí se pueden cargar."
        : "No se pudo leer el documento. Intente nuevamente o suba una foto más nítida.";
      await platformDb().aiIngestionJob.update({ where: { id: job.id }, data: { status: "FAILED", error: friendly } });
      console.error("[ai.ingest]", job.id, msg);
      throw new DomainError("AI_FAILED", friendly);
    }
    const after = await platformDb().aiIngestionJob.findUniqueOrThrow({ where: { id: job.id }, select: { status: true, error: true } });
    if (after.status === "FAILED") throw new DomainError("AI_FAILED", after.error ?? "No se pudo leer el documento.");
    return ok({ status: after.status });
  } catch (e) {
    return toActionError(e);
  }
}
