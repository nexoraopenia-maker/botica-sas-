import { requirePlatformAdmin } from "@/lib/auth/session";
import { platformDb } from "@/lib/db";
import { TenantForm } from "@/app/superadmin/_components/tenant-form";
import { PageHeader } from "@/app/app/_components/ui";

export default async function NewTenantPage() {
  await requirePlatformAdmin(["OWNER", "SUPPORT"]);
  const plans = await platformDb().plan.findMany({ where: { deleted_at: null }, orderBy: { monthly_price_pen: "asc" } });

  return (
    <div className="sa-detail">
      <PageHeader title="Nuevo cliente" subtitle="Alta de un negocio: queda en prueba y en ambiente SUNAT beta hasta completar el onboarding" />
      {plans.length === 0 ? (
        <p className="alert">No hay planes configurados. Ejecute <code>pnpm db:seed</code> o cree un plan antes de registrar clientes.</p>
      ) : (
        <TenantForm
          mode="create"
          plans={plans.map((p) => ({
            id: p.id, name: p.name, monthlyPrice: p.monthly_price_pen.toFixed(2), includedModules: p.included_modules,
          }))}
        />
      )}
    </div>
  );
}
