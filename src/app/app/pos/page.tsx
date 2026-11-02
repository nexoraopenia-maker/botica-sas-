import { requireTenant } from "@/lib/auth/session";
import { hasPermission } from "@/lib/auth/permissions";
import { loadPosContext } from "@/lib/inventory/pos-catalog";
import { EmptyState, Panel } from "../_components/ui";
import { Pos } from "./_components/pos";

export const metadata = { title: "Punto de venta" };
// La firma y el envío a SUNAT corren tras responder (after) dentro de la misma función
export const maxDuration = 60;

export default async function PosPage({ searchParams }: { searchParams: Promise<{ otc?: string }> }) {
  const { otc } = await searchParams;
  const ctx = await requireTenant({ permission: "pos.sell" });
  const pos = await loadPosContext({ tenantId: ctx.tenantId, userId: ctx.userId, branchIds: ctx.branchIds });
  if (!pos) {
    return (
      <Panel>
        <EmptyState icon="cart" title="Sin sucursal activa" text="Su usuario no tiene una sucursal activa asignada. Pida al administrador que la configure." />
      </Panel>
    );
  }
  return <Pos products={pos.products} branchId={pos.branchId} branchName={pos.branchName} series={pos.series} otcOnly={otc === "1"}
    canDispenseRx={ctx.modules.has("PHARMACY") && hasPermission(ctx.permissions, "pharmacy.dispense_rx")} />;
}
