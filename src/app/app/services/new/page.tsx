import { requirePage } from "@/lib/auth/session";
import { withTenant } from "@/lib/db";
import { EmptyState, PageHeader, Panel } from "../../_components/ui";
import { OrderForm } from "../_components/order-form";

export const metadata = { title: "Recepcionar vehículo" };

export default async function NewOrderPage() {
  const ctx = await requirePage({ permission: "services.manage", module: "WORKSHOP" });
  const branch = await withTenant({ tenantId: ctx.tenantId, userId: ctx.userId }, (tx) => tx.branch.findFirst({
    where: { is_active: true, deleted_at: null, ...(ctx.branchIds.length ? { id: { in: ctx.branchIds } } : {}) }, orderBy: { sunat_code: "asc" },
  }));
  return (
    <>
      <PageHeader title="Recepcionar vehículo o pieza" subtitle="Registre al cliente, el trabajo y las fotos del estado de ingreso" />
      <Panel>
        {branch ? <OrderForm branchId={branch.id} /> : <EmptyState icon="wrench" title="Sin sucursal activa" text="Su usuario no tiene una sucursal activa asignada." />}
      </Panel>
    </>
  );
}
