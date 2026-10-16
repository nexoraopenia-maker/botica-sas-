import { requireTenant } from "@/lib/auth/session";
import { ComingSoon } from "../../_components/ui";

export default async function Page() {
  await requireTenant({ permission: "purchases.ai_ingest", module: "AI_INVENTORY" });
  return <ComingSoon title="Cargar factura con IA" icon="sparkles" description="La lectura de facturas de compra desde foto, PDF o XML con revisión humana está lista en el servidor; la pantalla de carga y revisión se habilitará en la próxima actualización." />;
}
