import Link from "next/link";
import { requirePage } from "@/lib/auth/session";
import { MAX_IMPORT_ROWS } from "@/lib/inventory/import-format";
import { PageHeader, Panel } from "../../_components/ui";
import { ImportForm } from "./import-form";

export const metadata = { title: "Carga masiva de productos" };
// Aplicar un archivo grande puede tardar: la acción corre dentro de esta ruta
export const maxDuration = 60;

export default async function ImportProductsPage() {
  const ctx = await requirePage({ permission: "products.manage" });
  return (
    <>
      <PageHeader title="Carga masiva de productos" subtitle="Cree y actualice productos y categorías desde un archivo CSV o Excel"
        actions={<Link href="/app/inventory" className="app-btn">← Productos</Link>} />
      <Panel title="Cómo funciona">
        <ul className="imp-help">
          <li>El <strong>SKU</strong> identifica cada producto: si existe, se <strong>actualiza</strong>; si no, se <strong>crea</strong> (para crearlo hacen falta Nombre y Precio de venta).</li>
          <li>Una celda <strong>vacía no cambia</strong> el producto. Así puede completar solo la categoría o el tipo de miles de productos.</li>
          <li>Las <strong>categorías que no existan se crean</strong> solas.</li>
          <li>Columnas: SKU, Nombre, Precio de venta, Código de barras, Categoría{ctx.modules.has("PHARMACY") ? ", Principio Activo, Acción Terapéutica, De Marca / Genérico" : ""}, Indicador ICBPER (Sí/No). Máximo {MAX_IMPORT_ROWS} filas por archivo.</li>
          <li>Primero se <strong>revisa</strong> el archivo: no se guarda nada hasta que usted aplique, y si una fila tiene error no se aplica ninguna.</li>
        </ul>
        <p className="set-pad"><a href="/app/inventory/import/plantilla" className="app-btn" download>Descargar plantilla (CSV)</a></p>
      </Panel>
      <div style={{ height: 16 }} />
      <ImportForm pharmacy={ctx.modules.has("PHARMACY")} />
    </>
  );
}
