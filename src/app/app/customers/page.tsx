import { requireTenant } from "@/lib/auth/session";
import { withTenant } from "@/lib/db";
import { EmptyState, PageHeader, Panel } from "../_components/ui";

const DOCS: Record<string, string> = { DNI: "DNI", RUC: "RUC", CE: "C.E.", PASSPORT: "Pasaporte", NO_DOC: "—" };

export default async function CustomersPage() {
  const ctx = await requireTenant({ permission: "customers.manage" });
  const rows = await withTenant({ tenantId: ctx.tenantId, userId: ctx.userId }, (tx) =>
    tx.customer.findMany({ where: { deleted_at: null }, orderBy: { name: "asc" }, take: 500 }));
  return (
    <>
      <PageHeader title="Clientes" subtitle="Se registran automáticamente al emitir comprobantes con documento" />
      <Panel>
        {rows.length === 0 ? (
          <EmptyState icon="users" title="Sin clientes" text="Los clientes con DNI, RUC o carné de extranjería se guardan al venderles, para reutilizarlos en próximas ventas." />
        ) : (
          <div className="app-table-wrap"><table className="app-table">
            <thead><tr><th>Cliente</th><th>Documento</th><th>Contacto</th><th>Dirección</th></tr></thead>
            <tbody>{rows.map((c) => (
              <tr key={c.id}>
                <td><strong>{c.name}</strong></td>
                <td>{DOCS[c.doc_type]} {c.doc_number}</td>
                <td>{[c.phone, c.email].filter(Boolean).join(" · ") || "—"}</td>
                <td>{c.address ?? "—"}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Panel>
    </>
  );
}
