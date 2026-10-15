import { notFound } from "next/navigation";
import { z } from "zod";
import { requirePlatformAdmin } from "@/lib/auth/session";
import { platformDb } from "@/lib/db";
import { TenantForm, type TenantFormValues } from "@/app/superadmin/_components/tenant-form";
import { StatusButton } from "@/app/superadmin/_components/status-button";
import { STATUS_LABEL, type BusinessLineUI, type ModuleKeyUI } from "@/app/superadmin/_components/catalog";

export default async function EditTenantPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ created?: string }>;
}) {
  await requirePlatformAdmin();
  const { id } = await params;
  const { created } = await searchParams;
  if (!z.uuid().safeParse(id).success) notFound();

  const t = await platformDb().tenant.findUnique({
    where: { id },
    include: {
      modules: { where: { enabled: true } },
      subscriptions: { include: { plan: true }, orderBy: { created_at: "desc" }, take: 1 },
      members: { where: { deleted_at: null }, include: { user: true, role: true } },
    },
  });
  if (!t || t.status === "DELETED") notFound();

  const initial: TenantFormValues = {
    ruc: t.ruc, legalName: t.legal_name, tradeName: t.trade_name ?? "", fiscalAddress: t.fiscal_address,
    ubigeo: t.ubigeo, department: t.department, province: t.province, district: t.district,
    contactName: t.contact_name ?? "", contactEmail: t.contact_email, contactPhone: t.contact_phone ?? "",
    businessLines: t.business_lines as BusinessLineUI[], modules: t.modules.map((m) => m.module) as ModuleKeyUI[],
  };
  const st = STATUS_LABEL[t.status] ?? { label: t.status, tone: "" };
  const sub = t.subscriptions[0];
  const name = t.trade_name ?? t.legal_name;

  return (
    <main style={{ maxWidth: 960 }}>
      <div className="page-head">
        <div>
          <a href="/superadmin" className="muted">← Panel</a>
          <h1>{name}</h1>
          <span className={`tag ${st.tone}`}>{st.label}</span>{" "}
          <span className="tag">SUNAT {t.sunat_env === "BETA" ? "beta" : "producción"}</span>{" "}
          {sub && <span className="tag">{sub.plan.name}{sub.trial_ends_at ? ` · prueba hasta ${sub.trial_ends_at.toLocaleDateString("es-PE")}` : ""}</span>}
        </div>
        <StatusButton tenantId={t.id} name={name} status={t.status} />
      </div>

      {created && (
        <p className="success" role="status">
          Cliente registrado. Se envió la invitación al administrador. Siguiente paso del onboarding: cargar el certificado digital y la Clave SOL.
        </p>
      )}
      {t.status === "SUSPENDED" && t.suspension_reason && (
        <p className="alert">Suspendido: {t.suspension_reason}</p>
      )}

      <TenantForm mode="edit" tenantId={t.id} initial={initial} />

      <section className="card">
        <h2>Usuarios</h2>
        <table>
          <thead><tr><th>Nombre</th><th>Email</th><th>Rol</th><th>Estado</th></tr></thead>
          <tbody>
            {t.members.map((m) => (
              <tr key={m.id}>
                <td>{m.user.full_name}</td><td>{m.user.email}</td><td>{m.role.name}</td>
                <td><span className={`tag ${m.status === "ACTIVE" ? "ok" : "warn"}`}>{m.status === "INVITED" ? "Invitado" : m.status === "ACTIVE" ? "Activo" : "Deshabilitado"}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="card">
        <h2>Facturación electrónica</h2>
        <p className="muted" style={{ margin: 0 }}>
          Certificado: {t.certificate_expires_at ? `vence ${t.certificate_expires_at.toLocaleDateString("es-PE")}` : "no cargado"} ·
          Clave SOL: {t.sol_user ? `usuario ${t.sol_user}` : "no configurada"} ·
          Prueba beta: {t.sunat_beta_passed_at ? "aprobada" : "pendiente"}
        </p>
      </section>
    </main>
  );
}
