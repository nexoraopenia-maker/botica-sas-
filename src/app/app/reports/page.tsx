import { requireTenant } from "@/lib/auth/session";
import { ComingSoon } from "../_components/ui";

export default async function Page() {
  await requireTenant({ permission: "reports.read", module: "CORE" });
  return <ComingSoon title="Reportes" icon="chart" description="Aquí encontrará reportes de ventas, márgenes, mermas y rotación de inventario." />;
}
