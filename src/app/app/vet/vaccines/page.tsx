import { requireTenant } from "@/lib/auth/session";
import { listDueVaccines } from "@/lib/vet/vaccinations";
import { EmptyState, PageHeader, Panel } from "../../_components/ui";

export default async function DueVaccinesPage() {
  const ctx = await requireTenant({ permission: "vet.vaccinate", module: "VETERINARY" });
  const rows = await listDueVaccines({ tenantId: ctx.tenantId, userId: ctx.userId }, 30);
  return (
    <>
      <PageHeader title="Vacunas vencidas y por vencer" subtitle="Próximos 30 días · los propietarios reciben recordatorios a 7, 3 y 1 día y el mismo día" />
      <Panel>
        {rows.length === 0 ? (
          <EmptyState icon="syringe" title="Sin vacunas pendientes" text="No hay vacunas vencidas ni programadas para los próximos 30 días." />
        ) : (
          <div className="app-table-wrap"><table className="app-table stack">
            <thead><tr><th>Paciente</th><th>Propietario</th><th>Vacuna</th><th className="num">Dosis</th><th>Fecha</th><th>Estado</th></tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={`${r.pet_id}-${r.vaccine_name}`}>
                <td data-label="Paciente"><strong>{r.pet_name}</strong></td>
                <td data-label="Propietario">{r.owner_name}{r.owner_whatsapp && <span className="app-sub">{r.owner_whatsapp}</span>}</td>
                <td data-label="Vacuna">{r.vaccine_name}</td>
                <td data-label="Dosis" className="num">{r.dose_number}</td>
                <td data-label="Fecha">{r.next_due_at.toISOString().slice(0, 10)}</td>
                <td data-label="Estado">
                  <span className={`app-pill ${r.days_left < 0 ? "red" : r.days_left <= 7 ? "amber" : "blue"}`}>
                    {r.days_left < 0 ? `Vencida hace ${-r.days_left} d` : r.days_left === 0 ? "Hoy" : `En ${r.days_left} d`}
                  </span>
                </td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Panel>
    </>
  );
}
