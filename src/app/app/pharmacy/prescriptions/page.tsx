import { requireTenant } from "@/lib/auth/session";
import { withTenant } from "@/lib/db";
import { EmptyState, PageHeader, Panel } from "../../_components/ui";

const KIND: Record<string, string> = { SIMPLE: "Simple", RETAINED: "Retenida", SPECIAL: "Especial" };

export default async function PrescriptionsPage() {
  const ctx = await requireTenant({ permission: "pharmacy.dispense_rx", module: "PHARMACY" });
  const rows = await withTenant({ tenantId: ctx.tenantId, userId: ctx.userId }, (tx) =>
    tx.prescription.findMany({ where: { deleted_at: null }, orderBy: { issued_at: "desc" }, take: 200 }));
  return (
    <>
      <PageHeader title="Recetas" subtitle="Recetas validadas por el químico farmacéutico" />
      <Panel>
        {rows.length === 0 ? (
          <EmptyState icon="rx" title="Sin recetas registradas" text="Los productos con receta (simple, retenida o especial) exigen registrar y validar la receta antes de dispensar." />
        ) : (
          <div className="app-table-wrap"><table className="app-table">
            <thead><tr><th>Paciente</th><th>Prescriptor</th><th>Tipo</th><th>Emitida</th><th>Estado</th></tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.id}>
                <td><strong>{r.patient_name}</strong>{r.patient_doc && <span className="app-sub">{r.patient_doc}</span>}</td>
                <td>{r.prescriber_name}<span className="app-sub">Colegiatura {r.prescriber_cmp}</span></td>
                <td><span className={`app-pill ${r.kind === "SPECIAL" ? "red" : r.kind === "RETAINED" ? "amber" : "gray"}`}>{KIND[r.kind]}</span></td>
                <td>{r.issued_at.toISOString().slice(0, 10)}</td>
                <td>{r.dispensed_at ? <span className="app-pill green">Dispensada</span> : <span className="app-pill blue">Vigente</span>}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Panel>
    </>
  );
}
