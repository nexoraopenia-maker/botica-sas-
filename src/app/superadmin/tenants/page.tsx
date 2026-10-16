import Link from "next/link";
import { requirePlatformAdmin } from "@/lib/auth/session";
import { TenantTable } from "@/app/superadmin/_components/tenant-table";
import { PageHeader, Panel } from "@/app/app/_components/ui";

export default async function TenantsPage() {
  const admin = await requirePlatformAdmin();
  return (
    <>
      <PageHeader title="Clientes" subtitle="Negocios registrados en la plataforma"
        actions={<Link className="app-btn primary" href="/superadmin/tenants/new">+ Nuevo cliente</Link>} />
      <Panel><TenantTable admin={admin} /></Panel>
    </>
  );
}
