import { requireTenant } from "@/lib/auth/session";
import { listDueVaccines } from "@/lib/vet/vaccinations";

export default async function DueVaccinesPage() {
  const ctx = await requireTenant({ permission: "vet.vaccinate", module: "VETERINARY" });
  const rows = await listDueVaccines({ tenantId: ctx.tenantId, userId: ctx.userId }, 30);
  return (
    <>
      <h1>Vacunas vencidas y por vencer (30 días)</h1>
      <table>
        <thead><tr><th>Mascota</th><th>Propietario</th><th>Vacuna</th><th>Dosis</th><th>Fecha</th><th>Estado</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={`${r.pet_id}-${r.vaccine_name}`}>
              <td>{r.pet_name} <small>({r.species})</small></td>
              <td>{r.owner_name}{r.owner_whatsapp ? ` · ${r.owner_whatsapp}` : ""}</td>
              <td>{r.vaccine_name}</td>
              <td>{r.dose_number}</td>
              <td>{r.next_due_at.toISOString().slice(0, 10)}</td>
              <td>
                <span className={`tag ${r.days_left < 0 ? "bad" : r.days_left <= 7 ? "warn" : ""}`}>
                  {r.days_left < 0 ? `Vencida hace ${-r.days_left} d` : r.days_left === 0 ? "Hoy" : `En ${r.days_left} d`}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
