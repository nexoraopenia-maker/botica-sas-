import Link from "next/link";
import { requirePage } from "@/lib/auth/session";
import { getWhatsappStatus } from "@/lib/whatsapp/settings";
import { bridgeConfigured } from "@/lib/whatsapp/bridge";
import { PageHeader } from "../../_components/ui";
import { WhatsappSettings } from "./whatsapp-settings";

export const metadata = { title: "WhatsApp" };
export const maxDuration = 60; // "Ejecutar ahora" entrega los recordatorios tras responder

export default async function WhatsappPage() {
  const ctx = await requirePage({ permission: "settings.manage" });
  const status = await getWhatsappStatus(ctx.tenantId, bridgeConfigured());
  return (
    <>
      <PageHeader title="WhatsApp" subtitle="Conexión y recordatorios automáticos de vacunas y caducidad de stock"
        actions={<Link href="/app/settings" className="app-btn">Volver a Configuración</Link>} />
      {!ctx.modules.has("WHATSAPP") && (
        <p className="set-msg bad" role="status" style={{ marginBottom: 16 }}>
          El módulo WhatsApp no está activo en su plan: puede guardar la configuración, pero los recordatorios no se enviarán hasta activarlo.
        </p>
      )}
      <WhatsappSettings status={status} />
    </>
  );
}
