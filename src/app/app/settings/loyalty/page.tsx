import Link from "next/link";
import { requirePage } from "@/lib/auth/session";
import { withTenant } from "@/lib/db";
import { PageHeader, Panel } from "../../_components/ui";
import { LoyaltyForm } from "./loyalty-form";

export const metadata = { title: "Monedero" };

export default async function LoyaltyPage() {
  const ctx = await requirePage({ permission: "settings.manage" });
  const s = await withTenant({ tenantId: ctx.tenantId, userId: ctx.userId }, (tx) => tx.loyaltySettings.findUnique({ where: { tenant_id: ctx.tenantId } }));
  return (
    <>
      <PageHeader title="Monedero virtual" subtitle="Saldo a favor que los clientes acumulan y usan en el punto de venta"
        actions={<Link href="/app/settings" className="app-btn">Volver a Configuración</Link>} />
      <Panel><LoyaltyForm enabled={s?.enabled ?? false} percent={s?.earn_percent.toFixed(2) ?? "1.00"} /></Panel>
    </>
  );
}
