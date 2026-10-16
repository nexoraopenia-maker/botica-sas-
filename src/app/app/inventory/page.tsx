import Link from "next/link";
import { requireTenant } from "@/lib/auth/session";
import { hasPermission } from "@/lib/auth/permissions";
import { withTenant } from "@/lib/db";
import { formatStock } from "@/lib/pharmacy/fractioning";
import { D } from "@/lib/money";
import { EmptyState, PageHeader, Panel, soles } from "../_components/ui";

interface Row {
  id: string; sku: string; name: string; dci: string | null; sale_price: string; units_per_package: number;
  min_stock: string; available: string; expired: string; nearest_expiry: Date | null; batches: number;
}

export default async function InventoryPage({ searchParams }: { searchParams: Promise<{ created?: string }> }) {
  const { created } = await searchParams;
  const ctx = await requireTenant({ permission: "inventory.read" });
  const rows = await withTenant({ tenantId: ctx.tenantId, userId: ctx.userId }, (tx) => tx.$queryRaw<Row[]>`
    SELECT p.id, p.sku, p.name, p.dci, p.sale_price::text, p.units_per_package, p.min_stock::text,
           coalesce(sum(b.stock) FILTER (WHERE b.expiry_date IS NULL OR b.expiry_date >= app.lima_today()), 0)::text AS available,
           coalesce(sum(b.stock) FILTER (WHERE b.expiry_date < app.lima_today()), 0)::text AS expired,
           min(b.expiry_date) FILTER (WHERE b.stock > 0 AND b.expiry_date >= app.lima_today()) AS nearest_expiry,
           count(b.id) FILTER (WHERE b.stock > 0)::int AS batches
      FROM products p LEFT JOIN product_batches b ON b.product_id = p.id AND b.deleted_at IS NULL
     WHERE p.deleted_at IS NULL AND p.is_active
     GROUP BY p.id ORDER BY p.name LIMIT 500`);
  return (
    <>
      <PageHeader title="Productos y stock" subtitle="Stock vendible por producto (los lotes vencidos se excluyen de la venta)"
        actions={
          <>
            <Link href="/app/inventory/expiry" className="app-btn">Ver caducidad</Link>
            {hasPermission(ctx.permissions, "products.manage") && <Link href="/app/inventory/new" className="app-btn primary">+ Nuevo producto</Link>}
          </>
        } />
      {created && <p className="set-msg ok" role="status" style={{ marginBottom: 16 }}>Producto {created} creado.</p>}
      <Panel>
        {rows.length === 0 ? (
          <EmptyState icon="box" title="Aún no hay productos" text="Cargue su primera factura de compra con IA o registre productos para empezar a controlar lotes y vencimientos."
            action={hasPermission(ctx.permissions, "products.manage") ? <Link href="/app/inventory/new" className="app-btn primary">+ Nuevo producto</Link> : undefined} />
        ) : (
          <div className="app-table-wrap"><table className="app-table stack">
            <thead><tr><th>Producto</th><th className="num">Precio</th><th className="num">Stock vendible</th><th>Lotes</th><th>Próx. vencimiento</th><th>Estado</th></tr></thead>
            <tbody>{rows.map((r) => {
              const low = D(r.min_stock).gt(0) && D(r.available).lte(r.min_stock);
              return (
                <tr key={r.id}>
                  <td data-label="Producto"><strong>{r.name}</strong><span className="app-sub">{r.sku}{r.dci ? ` · ${r.dci}` : ""}</span></td>
                  <td data-label="Precio" className="num">{soles(r.sale_price)}</td>
                  <td data-label="Stock vendible" className="num">{formatStock(D(r.available), r.units_per_package)}</td>
                  <td data-label="Lotes">{r.batches}</td>
                  <td data-label="Próx. vencimiento">{r.nearest_expiry?.toISOString().slice(0, 10) ?? "—"}</td>
                  <td data-label="Estado">
                    {D(r.expired).gt(0) && <span className="app-pill red">Vencidos: {r.expired}</span>}{" "}
                    {low ? <span className="app-pill amber">Stock bajo</span> : D(r.available).isZero() ? <span className="app-pill gray">Sin stock</span> : <span className="app-pill green">OK</span>}
                  </td>
                </tr>
              );
            })}</tbody>
          </table></div>
        )}
      </Panel>
    </>
  );
}
