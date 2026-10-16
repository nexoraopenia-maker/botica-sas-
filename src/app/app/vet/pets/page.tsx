import { requireTenant } from "@/lib/auth/session";
import { withTenant } from "@/lib/db";
import { EmptyState, PageHeader, Panel } from "../../_components/ui";

const SPECIES: Record<string, string> = {
  CANINE: "Canino", FELINE: "Felino", BOVINE: "Bovino", OVINE: "Ovino", CAPRINE: "Caprino", PORCINE: "Porcino",
  EQUINE: "Equino", AVIAN: "Ave", CAVY: "Cuy", RABBIT: "Conejo", OTHER: "Otro",
};

export default async function PetsPage() {
  const ctx = await requireTenant({ permission: "vet.records", module: "VETERINARY" });
  const pets = await withTenant({ tenantId: ctx.tenantId, userId: ctx.userId }, (tx) =>
    tx.pet.findMany({ where: { deleted_at: null }, include: { owner: true }, orderBy: { name: "asc" }, take: 500 }));
  return (
    <>
      <PageHeader title="Pacientes" subtitle="Mascotas y animales atendidos, con su propietario" />
      <Panel>
        {pets.length === 0 ? (
          <EmptyState icon="paw" title="Sin pacientes" text="Registre pacientes para llevar su historia clínica y su carnet de vacunación con recordatorios automáticos." />
        ) : (
          <div className="app-table-wrap"><table className="app-table">
            <thead><tr><th>Paciente</th><th>Especie / raza</th><th>Propietario</th><th>Contacto</th><th>Estado</th></tr></thead>
            <tbody>{pets.map((p) => (
              <tr key={p.id}>
                <td><strong>{p.name}</strong>{p.microchip && <span className="app-sub">Chip {p.microchip}</span>}</td>
                <td>{SPECIES[p.species]}{p.breed ? ` · ${p.breed}` : ""}</td>
                <td>{p.owner.full_name}</td>
                <td>{p.owner.whatsapp ?? p.owner.phone ?? "—"}</td>
                <td>{p.deceased_at ? <span className="app-pill gray">Fallecido</span> : <span className="app-pill green">Activo</span>}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Panel>
    </>
  );
}
