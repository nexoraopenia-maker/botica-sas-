import { requireTenant } from "@/lib/auth/session";
import { ComingSoon } from "../_components/ui";

export default async function Page() {
  await requireTenant({ permission: "pos.sell", module: "CORE" });
  return <ComingSoon title="Punto de venta" icon="cart" description="El punto de venta con búsqueda por nombre, DCI o código de barras, descuento FEFO por lote y emisión de boletas y facturas está listo en el servidor; su pantalla de caja se habilitará en la próxima actualización." />;
}
