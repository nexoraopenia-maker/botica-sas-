import Link from "next/link";
import { requireTenant } from "@/lib/auth/session";
import { hasPermission } from "@/lib/auth/permissions";
import { loadInventoryList } from "@/lib/inventory/list";
import { formatStock } from "@/lib/pharmacy/fractioning";
import { D } from "@/lib/money";
import { bookMismatch } from "@/lib/pharmacy/controlled-rules";
import { EmptyState, PageHeader, Panel, soles } from "../_components/ui";

export default async function InventoryPage({ searchParams }: { searchParams: Promise<{ created?: string; ver?: string }> }) {
  const { created, ver } = await searchParams;
  const ctx = await requireTenant({ permission: "inventory.read" });
  const pharmacy = ctx.modules.has("PHARMACY");
  const onlyIncomplete = ver === "incompletos";
  const { rows, noCategory, noKind } = await loadInventoryList({ tenantId: ctx.tenantId, userId: ctx.userId }, { pharmacy, onlyIncomplete });
  const controlled = rows.filter((r) => r.is_controlled);
  const mismatched = controlled.filter((r) => bookMismatch(r.total_stock, r.book_balance));
  const onlyControlled = ver === "controlados";
  const visible = onlyControlled ? controlled : rows;
  const canSeeBook = ctx.modules.has("PHARMACY") && hasPermission(ctx.permissions, "pharmacy.controlled_log");
  return (
    <>
      <PageHeader title="Productos y stock" subtitle="Stock vendible por producto (los lotes vencidos se excluyen de la venta)"
        actions={
          <>
            <Link href="/app/inventory/expiry" className="app-btn">Ver caducidad</Link>
            {hasPermission(ctx.permissions, "products.manage") && <Link href="/app/inventory/import" className="app-btn">Carga masiva</Link>}
            {hasPermission(ctx.permissions, "products.manage") && <Link href="/app/inventory/new" className="app-btn primary">+ Nuevo producto</Link>}
          </>
        } />
      {created && <p className="set-msg ok" role="status" style={{ marginBottom: 16 }}>Producto {created} creado.</p>}
      {(noCategory > 0 || noKind > 0) && (
        <div className="inv-incomplete-note" role="status">
          <div>
            <strong>Hay productos con datos incompletos</strong>
            {noCategory > 0 && <p><strong>{noCategory}</strong> producto{noCategory === 1 ? "" : "s"} sin categoría: no aparecen en los filtros por categoría de la caja.</p>}
            {noKind > 0 && <p><strong>{noKind}</strong> medicamento{noKind === 1 ? "" : "s"} sin tipo (Marca o Genérico): la caja no les sugiere genéricos ni sustitutos.</p>}
          </div>
          <div className="inv-controlled-actions">
            <Link href={onlyIncomplete ? "/app/inventory" : "/app/inventory?ver=incompletos"} className="app-btn">{onlyIncomplete ? "Ver todos" : "Ver productos incompletos"}</Link>
            {hasPermission(ctx.permissions, "products.manage") && <Link href="/app/inventory/import" className="app-btn">Completar con carga masiva</Link>}
          </div>
        </div>
      )}
      {controlled.length > 0 && (
        <div className={`inv-controlled-note${mismatched.length ? " bad" : ""}`} role={mismatched.length ? "alert" : "status"}>
          <div>
            <strong>{controlled.length} producto{controlled.length === 1 ? "" : "s"} controlado{controlled.length === 1 ? "" : "s"} (psicotrópicos o estupefacientes)</strong>
            <p>Solo se dispensan con receta especial retenida, con DNI y colegiatura del médico. Cada movimiento queda en el libro de controlados.</p>
            {mismatched.length > 0 && <p><strong>Revise el libro:</strong> el saldo no coincide con el stock en {mismatched.map((r) => r.name).join(", ")}.</p>}
          </div>
          <div className="inv-controlled-actions">
            <Link href={onlyControlled ? "/app/inventory" : "/app/inventory?ver=controlados"} className="app-btn">{onlyControlled ? "Ver todos" : "Ver solo controlados"}</Link>
            {canSeeBook && <Link href="/app/pharmacy/controlled" className="app-btn">Libro de controlados</Link>}
          </div>
        </div>
      )}
      <Panel>
        {rows.length === 0 ? (
          <EmptyState icon="box" title="Aún no hay productos" text="Cargue su primera factura de compra con IA o registre productos para empezar a controlar lotes y vencimientos."
            action={hasPermission(ctx.permissions, "products.manage") ? <Link href="/app/inventory/new" className="app-btn primary">+ Nuevo producto</Link> : undefined} />
        ) : (
          <div className="app-table-wrap"><table className="app-table stack">
            <thead><tr><th>Producto</th><th className="num">Precio</th><th className="num">Stock vendible</th><th>Lotes</th><th>Próx. vencimiento</th><th>Estado</th></tr></thead>
            <tbody>{visible.map((r) => {
              const low = D(r.min_stock).gt(0) && D(r.available).lte(r.min_stock);
              return (
                <tr key={r.id} className={r.is_controlled ? "inv-controlled" : undefined}>
                  <td data-label="Producto"><strong>{r.name}</strong><span className="app-sub">{r.sku}{r.dci ? ` · ${r.dci}` : ""}</span></td>
                  <td data-label="Precio" className="num">{soles(r.sale_price)}</td>
                  <td data-label="Stock vendible" className="num">{formatStock(D(r.available), r.units_per_package, r.units_per_blister)}</td>
                  <td data-label="Lotes">{r.batches}</td>
                  <td data-label="Próx. vencimiento">{r.nearest_expiry?.toISOString().slice(0, 10) ?? "—"}</td>
                  <td data-label="Estado">
                    {r.is_controlled && <span className="app-pill red" title="Solo se dispensa con receta especial: DNI y colegiatura del médico">Controlado{r.controlled_list ? ` · ${r.controlled_list}` : ""}</span>}{" "}
                    {r.is_controlled && bookMismatch(r.total_stock, r.book_balance) && <span className="app-pill red" title={`Libro: ${r.book_balance ?? "sin movimientos"} · Stock: ${r.total_stock}`}>Libro descuadrado</span>}{" "}
                    {!r.category_id && <span className="app-pill gray" title="Sin categoría: no aparece en los filtros de la caja">Sin categoría</span>}{" "}
                    {pharmacy && !!r.dci && !r.kind && <span className="app-pill gray" title="Sin tipo Marca/Genérico: no se le sugieren sustitutos">Sin tipo</span>}{" "}
                    {!!r.withdrawal && <span className="app-pill red" title="Periodo de retiro antes del consumo humano">Retiro {r.withdrawal} d</span>}{" "}
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
