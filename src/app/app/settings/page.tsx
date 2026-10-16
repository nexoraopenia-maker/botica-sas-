import { requireTenant } from "@/lib/auth/session";
import { ComingSoon } from "../_components/ui";

export default async function Page() {
  await requireTenant({ permission: "settings.manage", module: "CORE" });
  return <ComingSoon title="Configuración" icon="settings" description="Aquí podrá gestionar usuarios, sucursales, series de comprobantes y umbrales de alertas de su negocio." />;
}
