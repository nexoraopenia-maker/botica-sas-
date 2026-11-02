import { requireTenant } from "@/lib/auth/session";
import { hasPermission } from "@/lib/auth/permissions";
import { NewPrescription, RegisterPharmacist } from "../_components/prescriptions-panel";
import { withTenant } from "@/lib/db";
import { EmptyState, PageHeader, Panel } from "../../_components/ui";

const KIND: Record<string, string> = { SIMPLE: "Simple", RETAINED: "Retenida", SPECIAL: "Especial" };

export default async function PrescriptionsPage({ searchParams }: { searchParams: Promise<{ nueva?: string }> }) {
  const { nueva } = await searchParams;
  const ctx = await requireTenant({ permission: "pharmacy.dispense_rx", module: "PHARMACY" });
  const { rows, branch, staff, members } = await withTenant({ tenantId: ctx.tenantId, userId: ctx.userId }, async (tx) => {
    const [rows, branch, staff, members] = await Promise.all([
      tx.prescription.findMany({ where: { deleted_at: null }, orderBy: { issued_at: "desc" }, take: 200 }),
      tx.branch.findFirst({ where: { is_active: true, deleted_at: null, ...(ctx.branchIds.length ? { id: { in: ctx.branchIds } } : {}) }, orderBy: { sunat_code: "asc" } }),
      tx.pharmacistStaff.findMany({ where: { deleted_at: null, OR: [{ valid_to: null }, { valid_to: { gte: new Date() } }] }, orderBy: { full_name: "asc" } }),
      tx.tenantUser.findMany({ where: { status: "ACTIVE", deleted_at: null }, include: { user: { select: { full_name: true, email: true } } } }),
    ]);
    return { rows, branch, staff, members };
  });
  const isQf = !!branch && staff.some((s) => s.user_id === ctx.userId && s.branch_id === branch.id);
  const canManage = hasPermission(ctx.permissions, "settings.manage");
  return (
    <>
      <PageHeader title="Recetas" subtitle="Recetas validadas por el químico farmacéutico" />
      {branch && isQf && (
        <>
          <Panel title="Validar receta"><NewPrescription branchId={branch.id} initialKind={nueva === "controlada" ? "SPECIAL" : "SIMPLE"} /></Panel>
          <div style={{ height: 16 }} />
        </>
      )}
      {branch && !isQf && (
        <p className="set-msg bad" role="status" style={{ marginBottom: 16 }}>
          Solo un químico farmacéutico registrado en la sucursal puede validar recetas.{canManage ? " Regístrelo a continuación." : " Pida al administrador que lo registre."}
        </p>
      )}
      {branch && canManage && (
        <>
          <Panel title={`Químicos farmacéuticos · ${branch.name}`}>
            {staff.filter((s) => s.branch_id === branch.id).length > 0 && (
              <ul className="app-alerts set-pad">
                {staff.filter((s) => s.branch_id === branch.id).map((s) => <li key={s.id}>{s.full_name} · CQFP {s.cqfp_number}{s.is_technical_director ? " · Director técnico" : ""}</li>)}
              </ul>
            )}
            <RegisterPharmacist branchId={branch.id} members={members.map((m) => ({ userId: m.user_id, name: m.user.full_name ?? m.user.email }))} />
          </Panel>
          <div style={{ height: 16 }} />
        </>
      )}
      <Panel>
        {rows.length === 0 ? (
          <EmptyState icon="rx" title="Sin recetas registradas" text="Los productos con receta (simple, retenida o especial) exigen registrar y validar la receta antes de dispensar." />
        ) : (
          <div className="app-table-wrap"><table className="app-table stack">
            <thead><tr><th>Paciente</th><th>Prescriptor</th><th>Tipo</th><th>Emitida</th><th>Estado</th></tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.id}>
                <td data-label="Paciente"><strong>{r.patient_name}</strong>{r.patient_doc && <span className="app-sub">{r.patient_doc}</span>}</td>
                <td data-label="Prescriptor">{r.prescriber_name}<span className="app-sub">Colegiatura {r.prescriber_cmp}{r.prescriber_doc ? ` · DNI ${r.prescriber_doc}` : ""}</span></td>
                <td data-label="Tipo"><span className={`app-pill ${r.kind === "SPECIAL" ? "red" : r.kind === "RETAINED" ? "amber" : "gray"}`}>{KIND[r.kind]}</span></td>
                <td data-label="Emitida">{r.issued_at.toISOString().slice(0, 10)}</td>
                <td data-label="Estado">{r.dispensed_at ? <span className="app-pill green">Dispensada</span> : <span className="app-pill blue">Vigente</span>}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Panel>
    </>
  );
}
