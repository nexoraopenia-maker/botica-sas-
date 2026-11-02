import { requirePage } from "@/lib/auth/session";
import { withTenant } from "@/lib/db";
import { EmptyState, PageHeader, Panel } from "../../../_components/ui";
import { RecordForm } from "./record-form";

export const metadata = { title: "Nueva historia clínica" };

export default async function NewRecordPage({ searchParams }: { searchParams: Promise<{ paciente?: string }> }) {
  const { paciente } = await searchParams;
  const ctx = await requirePage({ permission: "vet.records", module: "VETERINARY" });
  const { pets, branch } = await withTenant({ tenantId: ctx.tenantId, userId: ctx.userId }, async (tx) => {
    const [pets, branch] = await Promise.all([
      tx.pet.findMany({ where: { deleted_at: null, deceased_at: null }, include: { owner: { select: { full_name: true } } }, orderBy: { name: "asc" }, take: 1000 }),
      tx.branch.findFirst({ where: { is_active: true, deleted_at: null, ...(ctx.branchIds.length ? { id: { in: ctx.branchIds } } : {}) }, orderBy: { sunat_code: "asc" } }),
    ]);
    return { pets, branch };
  });
  return (
    <>
      <PageHeader title="Nueva historia clínica" subtitle="Registre la atención de un paciente nuevo o existente" />
      <Panel>
        {!branch ? <EmptyState icon="paw" title="Sin sucursal activa" text="Su usuario no tiene una sucursal activa asignada." /> : (
          <RecordForm branchId={branch.id} initialPetId={pets.some((p) => p.id === paciente) ? paciente : undefined}
            pets={pets.map((p) => ({ id: p.id, label: `${p.name} · ${p.owner.full_name}` }))} />
        )}
      </Panel>
    </>
  );
}
