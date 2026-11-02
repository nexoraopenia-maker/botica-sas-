import Link from "next/link";
import { requirePage } from "@/lib/auth/session";
import { withTenant } from "@/lib/db";
import { limaNow } from "@/lib/time";
import { EmptyState, PageHeader, Panel } from "../../_components/ui";

export const metadata = { title: "Pacientes de hoy" };

export default async function TodayPage() {
  const ctx = await requirePage({ permission: "vet.records", module: "VETERINARY" });
  const today = limaNow().date;
  const { records, due } = await withTenant({ tenantId: ctx.tenantId, userId: ctx.userId }, async (tx) => {
    const [records, due] = await Promise.all([
      tx.medicalRecord.findMany({
        where: { deleted_at: null, visit_at: { gte: new Date(`${today}T00:00:00-05:00`), lt: new Date(`${today}T24:00:00-05:00`) } },
        include: { pet: { include: { owner: { select: { full_name: true } } } } }, orderBy: { visit_at: "desc" },
      }),
      tx.petVaccination.findMany({
        where: { deleted_at: null, next_due_at: new Date(`${today}T00:00:00Z`) },
        include: { pet: { include: { owner: { select: { full_name: true, whatsapp: true } } } }, vaccine: { select: { name: true } } },
      }),
    ]);
    return { records, due };
  });
  return (
    <>
      <PageHeader title="Pacientes de hoy" subtitle="Atenciones registradas y vacunas programadas para hoy"
        actions={<Link href="/app/vet/records/new" className="app-btn primary">+ Nueva historia clínica</Link>} />
      <div className="app-grid-2">
        <Panel title={`Atendidos (${records.length})`}>
          {records.length === 0 ? <EmptyState icon="paw" title="Sin atenciones hoy" text="Las historias clínicas registradas hoy aparecerán aquí." /> : (
            <div className="app-table-wrap"><table className="app-table"><tbody>{records.map((r) => (
              <tr key={r.id}>
                <td><Link className="app-link" href={`/app/vet/pets/${r.pet_id}`}><strong>{r.pet.name}</strong></Link><span className="app-sub">{r.pet.owner.full_name}</span></td>
                <td>{r.reason ?? "—"}</td>
                <td>{r.visit_at.toLocaleTimeString("es-PE", { timeZone: "America/Lima", hour: "2-digit", minute: "2-digit" })}</td>
              </tr>
            ))}</tbody></table></div>
          )}
        </Panel>
        <Panel title={`Vacunas de hoy (${due.length})`}>
          {due.length === 0 ? <EmptyState icon="syringe" title="Sin vacunas para hoy" text="Las vacunas programadas para hoy aparecerán aquí." /> : (
            <div className="app-table-wrap"><table className="app-table"><tbody>{due.map((v) => (
              <tr key={v.id}>
                <td><Link className="app-link" href={`/app/vet/pets/${v.pet_id}`}><strong>{v.pet.name}</strong></Link><span className="app-sub">{v.pet.owner.full_name}{v.pet.owner.whatsapp ? ` · ${v.pet.owner.whatsapp}` : ""}</span></td>
                <td>{v.vaccine.name}</td>
              </tr>
            ))}</tbody></table></div>
          )}
        </Panel>
      </div>
    </>
  );
}
