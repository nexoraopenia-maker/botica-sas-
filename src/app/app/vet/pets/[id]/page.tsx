import Link from "next/link";
import { notFound } from "next/navigation";
import { requireTenant } from "@/lib/auth/session";
import { withTenant } from "@/lib/db";
import { MessageInbox } from "../../../_components/message-inbox";
import { PageHeader, Panel } from "../../../_components/ui";

const VISIT: Record<string, string> = { CONSULTATION: "Consulta", VACCINATION: "Vacunación", DEWORMING: "Desparasitación", HOSPITALIZATION: "Hospitalización", SURGERY: "Cirugía", GROOMING: "Baño y corte", CONTROL: "Control" };

export default async function PetPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireTenant({ permission: "vet.records", module: "VETERINARY" });
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const db = { tenantId: ctx.tenantId, userId: ctx.userId };
  const pet = await withTenant(db, (tx) => tx.pet.findFirst({
    where: { id, deleted_at: null },
    include: {
      owner: true,
      records: { where: { deleted_at: null }, orderBy: { visit_at: "desc" }, take: 20 },
      vaccinations: { where: { deleted_at: null }, include: { vaccine: { select: { name: true } } }, orderBy: { applied_at: "desc" }, take: 20 },
    },
  }));
  if (!pet) notFound();
  return (
    <>
      <PageHeader title={pet.name} subtitle={`Propietario: ${pet.owner.full_name}${pet.owner.whatsapp ? ` · ${pet.owner.whatsapp}` : ""}`}
        actions={<>
          <a href={`/app/vet/pets/${pet.id}/cartilla`} className="app-btn">Cartilla QR (PDF)</a>
          <Link href={`/app/vet/records/new?paciente=${pet.id}`} className="app-btn primary">+ Nueva atención</Link>
        </>} />
      {pet.allergies && <p className="set-msg bad" role="alert" style={{ marginBottom: 16 }}>Alergias: {pet.allergies}</p>}
      <div className="app-grid-2">
        <Panel title="Historia clínica">
          {pet.records.length === 0 ? <p className="app-muted set-pad">Sin atenciones registradas.</p> : (
            <div className="app-table-wrap"><table className="app-table stack">
              <thead><tr><th>Fecha</th><th>Tipo</th><th>Motivo / diagnóstico</th></tr></thead>
              <tbody>{pet.records.map((r) => (
                <tr key={r.id}>
                  <td data-label="Fecha">{r.visit_at.toLocaleDateString("es-PE", { timeZone: "America/Lima" })}</td>
                  <td data-label="Tipo">{VISIT[r.visit_type]}</td>
                  <td data-label="Motivo"><strong>{r.reason ?? "—"}</strong>{r.diagnosis && <span className="app-sub">{r.diagnosis}</span>}</td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
        </Panel>
        <div className="app-stack">
          <Panel title="Vacunas">
            {pet.vaccinations.length === 0 ? <p className="app-muted set-pad">Sin vacunas registradas.</p> : (
              <div className="app-table-wrap"><table className="app-table"><tbody>{pet.vaccinations.map((v) => (
                <tr key={v.id}><td><strong>{v.vaccine.name}</strong><span className="app-sub">Dosis {v.dose_number}</span></td><td>{v.applied_at.toISOString().slice(0, 10)}</td><td>{v.next_due_at ? `Próx. ${v.next_due_at.toISOString().slice(0, 10)}` : "—"}</td></tr>
              ))}</tbody></table></div>
            )}
          </Panel>
          <MessageInbox ctx={db} phones={[pet.owner.whatsapp, pet.owner.phone]} />
        </div>
      </div>
    </>
  );
}
