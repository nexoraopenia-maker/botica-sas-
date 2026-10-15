import { requirePlatformAdmin } from "@/lib/auth/session";
import { TenantTable } from "@/app/superadmin/_components/tenant-table";

export default async function TenantsPage() {
  await requirePlatformAdmin();
  return (
    <main>
      <div className="page-head">
        <h1>Clientes</h1>
        <a className="btn primary" href="/superadmin/tenants/new">+ Nuevo cliente</a>
      </div>
      <TenantTable />
    </main>
  );
}
