import "server-only";
import { platformDb } from "@/lib/db";
import { limaPeriod } from "@/lib/time";

export interface PlatformDashboard {
  tenantsByStatus: { status: string; count: number }[];
  mrrPen: string;
  documentsThisMonth: number;
  sunatErrors30d: { tenant_id: string; legal_name: string; rejected: number; retrying: number }[];
  certificatesExpiring: { tenant_id: string; legal_name: string; expires_at: Date; days_left: number }[];
  aiUsage: { tenant_id: string; legal_name: string; pages: number; input_tokens: number; output_tokens: number }[];
  deadOutbox: number;
}

export async function getPlatformDashboard(): Promise<PlatformDashboard> {
  const db = platformDb();
  const period = limaPeriod();
  const [byStatus, mrr, docs, errors, certs, ai, dead] = await Promise.all([
    db.$queryRaw<{ status: string; count: number }[]>`
      SELECT status::text, count(*)::int AS count FROM tenants WHERE deleted_at IS NULL GROUP BY status`,
    db.$queryRaw<[{ mrr: string | null }]>`
      SELECT coalesce(sum(CASE WHEN s.status = 'ACTIVE' THEN
               coalesce(p.annual_price_pen / 12, p.monthly_price_pen) END), 0)::text AS mrr
        FROM subscriptions s JOIN plans p ON p.id = s.plan_id`,
    db.$queryRaw<[{ n: number }]>`
      SELECT count(*)::int AS n FROM documents
       WHERE issue_date >= date_trunc('month', (now() AT TIME ZONE 'America/Lima'))::date`,
    db.$queryRaw<PlatformDashboard["sunatErrors30d"]>`
      SELECT d.tenant_id, t.legal_name,
             count(*) FILTER (WHERE d.status = 'RECHAZADO')::int AS rejected,
             count(*) FILTER (WHERE d.status = 'ERROR_REINTENTABLE')::int AS retrying
        FROM documents d JOIN tenants t ON t.id = d.tenant_id
       WHERE d.created_at > now() - interval '30 days' AND d.status IN ('RECHAZADO', 'ERROR_REINTENTABLE')
       GROUP BY d.tenant_id, t.legal_name ORDER BY rejected DESC, retrying DESC LIMIT 20`,
    db.$queryRaw<PlatformDashboard["certificatesExpiring"]>`
      SELECT id AS tenant_id, legal_name, certificate_expires_at AS expires_at,
             (certificate_expires_at::date - (now() AT TIME ZONE 'America/Lima')::date)::int AS days_left
        FROM tenants
       WHERE status IN ('TRIAL', 'ACTIVE') AND certificate_expires_at < now() + interval '45 days'
       ORDER BY certificate_expires_at`,
    db.$queryRaw<PlatformDashboard["aiUsage"]>`
      SELECT u.tenant_id, t.legal_name,
             coalesce(max(u.value) FILTER (WHERE metric = 'ai_pages'), 0)::int AS pages,
             coalesce(max(u.value) FILTER (WHERE metric = 'ai_input_tokens'), 0)::int AS input_tokens,
             coalesce(max(u.value) FILTER (WHERE metric = 'ai_output_tokens'), 0)::int AS output_tokens
        FROM usage_counters u JOIN tenants t ON t.id = u.tenant_id
       WHERE u.period = ${period}
       GROUP BY u.tenant_id, t.legal_name ORDER BY pages DESC LIMIT 50`,
    db.outboxEvent.count({ where: { status: "DEAD" } }),
  ]);
  return {
    tenantsByStatus: byStatus,
    mrrPen: mrr[0]?.mrr ?? "0",
    documentsThisMonth: docs[0]?.n ?? 0,
    sunatErrors30d: errors,
    certificatesExpiring: certs,
    aiUsage: ai,
    deadOutbox: dead,
  };
}
