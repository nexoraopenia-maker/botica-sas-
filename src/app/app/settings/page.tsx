import { requireTenant } from "@/lib/auth/session";
import { hasPermission } from "@/lib/auth/permissions";
import { withTenant } from "@/lib/db";
import { ALERT_DEFAULTS, ALERT_KINDS } from "@/lib/settings/service";
import { PageHeader } from "../_components/ui";
import { SettingsView, type AlertRuleView, type BranchView, type MemberView, type SeriesView } from "./_components/settings-view";

export const metadata = { title: "Configuración" };

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const ctx = await requireTenant({ permission: "settings.manage" });
  const { tab } = await searchParams;
  const canUsers = hasPermission(ctx.permissions, "users.manage");
  const data = await withTenant({ tenantId: ctx.tenantId, userId: ctx.userId }, async (tx) => {
    const [branches, series, rules, roles, sub, members] = await Promise.all([
      tx.branch.findMany({ where: { deleted_at: null }, orderBy: { sunat_code: "asc" } }),
      tx.documentSeries.findMany({ orderBy: [{ doc_type: "asc" }, { series: "asc" }] }),
      tx.alertRule.findMany(),
      tx.role.findMany({ where: { deleted_at: null }, orderBy: { name: "asc" }, select: { key: true, name: true } }),
      tx.subscription.findFirst({ where: { status: { in: ["ACTIVE", "TRIALING", "PAST_DUE"] } }, include: { plan: true }, orderBy: { created_at: "desc" } }),
      canUsers
        ? tx.tenantUser.findMany({ where: { deleted_at: null }, include: { user: true, role: true }, orderBy: { created_at: "asc" } })
        : Promise.resolve([]),
    ]);
    return { branches, series, rules, roles, members, maxBranches: sub?.plan.max_branches ?? 1, maxUsers: sub?.plan.max_users ?? 1 };
  });

  const branches: BranchView[] = data.branches.map((b) => ({
    id: b.id, sunatCode: b.sunat_code, name: b.name, address: b.address, ubigeo: b.ubigeo, phone: b.phone ?? "", isActive: b.is_active,
  }));
  const series: SeriesView[] = data.series.map((s) => ({
    id: s.id, branchId: s.branch_id, docType: s.doc_type, series: s.series, lastNumber: s.last_number, isActive: s.is_active,
  }));
  const members: MemberView[] = data.members.map((m) => ({
    id: m.id, email: m.user.email, fullName: m.user.full_name, roleKey: m.role.key, roleName: m.role.name,
    status: m.status as MemberView["status"], branchIds: m.branch_ids, isSelf: m.user_id === ctx.userId,
  }));
  const kinds = ALERT_KINDS.filter((k) => k !== "VACCINE_DUE" || ctx.modules.has("VETERINARY"));
  const rules: AlertRuleView[] = kinds.map((kind) => {
    const r = data.rules.find((x) => x.kind === kind);
    const d = ALERT_DEFAULTS[kind];
    return {
      kind,
      enabled: r?.enabled ?? true,
      thresholds: r?.thresholds ?? d.thresholds,
      channels: (r?.channels ?? d.channels) as AlertRuleView["channels"],
      recipientRoles: r?.recipient_roles ?? d.roles,
    };
  });

  return (
    <>
      <PageHeader title="Configuración" subtitle="Sucursales, series de comprobantes, usuarios y alertas de su negocio" />
      <SettingsView
        initialTab={tab === "series" || tab === "alerts" || (tab === "users" && canUsers) ? tab : "branches"}
        branches={branches}
        series={series}
        rules={rules}
        roles={data.roles}
        maxBranches={data.maxBranches}
        whatsappEnabled={ctx.modules.has("WHATSAPP")}
        members={canUsers ? members : null}
        maxUsers={data.maxUsers}
      />
    </>
  );
}
