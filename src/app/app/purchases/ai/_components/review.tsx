"use client";

import Link from "next/link";
import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { approveIngestionAction, runIngestionAction } from "../actions";

export interface ReviewJob {
  id: string;
  status: string;
  sourceKind: "IMAGE" | "PDF" | "XML";
  error: string | null;
  warnings: string[];
  confidence: number | null;
  previewUrl: string | null;
  purchaseId: string | null;
  duplicateOfPurchaseId: string | null;
  header: { supplierRuc: string; supplierName: string; docType: "01" | "03" | "09"; series: string; number: string; issueDate: string; currency: "PEN" | "USD" };
}
export interface ReviewItem {
  id: string; lineNo: number; description: string; quantity: string; unitCode: string | null; unitPrice: string; igvIncluded: boolean;
  lotCode: string | null; expiryDate: string | null; confidence: number; matchedProductId: string | null; matchMethod: string;
  candidates: { productId: string; name: string; score: number }[]; unitsPerPackage: number | null; status: string;
}
export interface ProductOption { id: string; name: string; sku: string; unitsPerPackage: number }

interface Line {
  action: "RECEIVE" | "IGNORE";
  productId: string; // "" = sin asignar, "new" = crear
  newName: string; newSku: string; newPrice: string;
  quantity: string; purchaseUnit: "UNIT" | "PACKAGE"; unitsPerPackage: string; unitCost: string;
  lot: string; expiry: string;
}

const METHOD: Record<string, string> = { EXACT_CODE: "código/historial", TRIGRAM: "nombre similar", VECTOR: "semántico", MANUAL: "manual", NONE: "" };
const skuFrom = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 20);

export function Review({ job, items, products }: { job: ReviewJob; items: ReviewItem[]; products: ProductOption[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [h, setH] = useState(job.header);
  const [fx, setFx] = useState("");
  const [lines, setLines] = useState<Line[]>(() => items.map((it) => {
    const cost = Number(it.unitPrice) / (it.igvIncluded ? 1.18 : 1);
    const upp = it.unitsPerPackage ?? products.find((p) => p.id === it.matchedProductId)?.unitsPerPackage ?? 1;
    return {
      action: "RECEIVE",
      productId: it.status === "NEW_PRODUCT" ? "new" : (it.matchedProductId ?? ""),
      newName: it.description, newSku: skuFrom(it.description), newPrice: (cost * 1.18 * 1.3).toFixed(2),
      quantity: it.quantity, purchaseUnit: upp > 1 ? "PACKAGE" : "UNIT", unitsPerPackage: String(upp),
      unitCost: cost.toFixed(4), lot: it.lotCode ?? "", expiry: it.expiryDate ?? "",
    };
  }));
  const productName = useMemo(() => new Map(products.map((p) => [p.id, p.name])), [products]);
  const update = (idx: number, patch: Partial<Line>) => setLines((prev) => prev.map((l, i) => (i === idx ? { ...l, ...patch } : l)));

  const receiving = lines.filter((l) => l.action === "RECEIVE");
  const subtotal = receiving.reduce((a, l) => a + Number(l.quantity || 0) * Number(l.unitCost || 0), 0);
  const unassigned = receiving.filter((l) => !l.productId).length;
  const editable = job.status === "NEEDS_REVIEW";

  function approve() {
    setError(null);
    if (unassigned) return setError(`Asigne un producto a ${unassigned} línea(s) o márquelas como «No ingresar».`);
    if (h.currency === "USD" && !Number(fx)) return setError("Indique el tipo de cambio para compras en dólares.");
    start(async () => {
      const res = await approveIngestionAction({
        jobId: job.id,
        supplier: { ruc: h.supplierRuc.trim(), legalName: h.supplierName.trim() },
        header: { docType: h.docType, series: h.series.trim().toUpperCase(), number: h.number.trim(), issueDate: h.issueDate, currency: h.currency, exchangeRate: h.currency === "USD" ? fx : undefined },
        items: lines.map((l, i) => ({
          itemId: items[i]!.id,
          action: l.action,
          productId: l.productId && l.productId !== "new" ? l.productId : undefined,
          newProduct: l.productId === "new" ? {
            name: l.newName.trim(), sku: l.newSku.trim(), salePrice: l.newPrice, unitsPerPackage: l.purchaseUnit === "PACKAGE" ? Number(l.unitsPerPackage) : 1,
          } : undefined,
          quantity: l.quantity, purchaseUnit: l.purchaseUnit, unitsPerPackage: Number(l.unitsPerPackage) || 1,
          unitCostWithoutIgv: l.unitCost, lotCode: l.lot.trim() || undefined, expiryDate: l.expiry || undefined,
        })),
      });
      if (!res.ok) {
        const field = res.error.fieldErrors ? Object.entries(res.error.fieldErrors).map(([k, v]) => `${k}: ${v?.[0]}`)[0] : undefined;
        return setError(field ?? res.error.message);
      }
      router.refresh();
    });
  }

  function retry() {
    setError(null);
    start(async () => {
      const res = await runIngestionAction(job.id);
      if (!res.ok) setError(res.error.message);
      router.refresh();
    });
  }

  // ── Estados terminales ──
  if (job.status === "COMMITTED") {
    return (
      <div className="app-panel ai-done">
        <span className="pos-receipt-ok" aria-hidden>✓</span>
        <h2>Compra registrada</h2>
        <p className="app-muted">Los productos ingresaron al inventario con sus lotes y vencimientos.</p>
        <div className="ai-drop-actions"><Link href="/app/purchases" className="app-btn">Ver compras</Link><Link href="/app/purchases/ai" className="app-btn primary">Cargar otra factura</Link></div>
      </div>
    );
  }
  if (job.status === "DUPLICATE") {
    return (
      <div className="app-panel ai-done">
        <h2>Esta factura ya fue registrada</h2>
        <p className="app-muted">El proveedor, la serie y el número coinciden con una compra existente; no se duplicó el stock.</p>
        <div className="ai-drop-actions"><Link href="/app/purchases" className="app-btn">Ver compras</Link><Link href="/app/purchases/ai" className="app-btn primary">Cargar otra factura</Link></div>
      </div>
    );
  }
  if (!editable) {
    return (
      <div className="app-panel ai-done">
        <h2>{job.status === "FAILED" ? "No se pudo leer el documento" : "Procesando documento…"}</h2>
        <p className="app-muted">{job.error ?? "La lectura aún no termina."}</p>
        {error && <p className="set-msg bad">{error}</p>}
        <div className="ai-drop-actions">
          <Link href="/app/purchases/ai" className="app-btn">Subir otro archivo</Link>
          <button type="button" className="app-btn primary" onClick={retry} disabled={pending}>{pending ? "Procesando…" : "Reintentar lectura"}</button>
        </div>
      </div>
    );
  }

  return (
    <div className="ai-review">
      {job.previewUrl && job.sourceKind !== "XML" && (
        <aside className="ai-preview app-panel">
          <header className="app-panel-head"><h2>Documento original</h2>
            <a href={job.previewUrl} target="_blank" rel="noreferrer" className="app-link">Abrir</a></header>
          {job.sourceKind === "IMAGE"
            // eslint-disable-next-line @next/next/no-img-element -- URL firmada temporal de Storage privado
            ? <img src={job.previewUrl} alt="Factura de compra subida" />
            : <p className="app-muted set-pad">Documento PDF. Use «Abrir» para verlo junto a esta revisión.</p>}
        </aside>
      )}

      <div className="app-stack">
        {job.warnings.length > 0 && (
          <div className="ai-warnings" role="alert">
            <strong>Revise antes de guardar</strong>
            <ul>{job.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
          </div>
        )}

        <section className="app-panel">
          <header className="app-panel-head">
            <h2>Datos del comprobante</h2>
            {job.confidence !== null && (
              <span className={`app-pill ${job.confidence >= 0.85 ? "green" : job.confidence >= 0.75 ? "amber" : "red"}`}>
                Confianza de lectura {Math.round(job.confidence * 100)}%
              </span>
            )}
          </header>
          <div className="set-form">
            <label className="set-field"><span>RUC del proveedor *</span>
              <input value={h.supplierRuc} maxLength={11} inputMode="numeric" onChange={(e) => setH({ ...h, supplierRuc: e.target.value.replace(/\D/g, "") })} /></label>
            <label className="set-field wide"><span>Razón social *</span>
              <input value={h.supplierName} onChange={(e) => setH({ ...h, supplierName: e.target.value })} /></label>
            <label className="set-field"><span>Tipo</span>
              <select value={h.docType} onChange={(e) => setH({ ...h, docType: e.target.value as "01" | "03" | "09" })}>
                <option value="01">Factura</option><option value="03">Boleta</option><option value="09">Guía de remisión</option>
              </select></label>
            <label className="set-field"><span>Serie *</span><input value={h.series} maxLength={4} onChange={(e) => setH({ ...h, series: e.target.value.toUpperCase() })} /></label>
            <label className="set-field"><span>Número *</span><input value={h.number} maxLength={10} onChange={(e) => setH({ ...h, number: e.target.value })} /></label>
            <label className="set-field"><span>Fecha de emisión *</span><input type="date" value={h.issueDate} onChange={(e) => setH({ ...h, issueDate: e.target.value })} /></label>
            <label className="set-field"><span>Moneda</span>
              <select value={h.currency} onChange={(e) => setH({ ...h, currency: e.target.value as "PEN" | "USD" })}>
                <option value="PEN">Soles (PEN)</option><option value="USD">Dólares (USD)</option>
              </select></label>
            {h.currency === "USD" && (
              <label className="set-field"><span>Tipo de cambio *</span><input inputMode="decimal" value={fx} onChange={(e) => setFx(e.target.value)} placeholder="3.750" /></label>
            )}
          </div>
        </section>

        <section className="app-panel">
          <header className="app-panel-head"><h2>Productos ({items.length})</h2>
            <span className="app-sub">Costos sin IGV · el stock ingresa por lote</span></header>
          <div className="ai-lines">
            {lines.map((l, i) => {
              const it = items[i]!;
              const low = it.confidence < 0.75;
              return (
                <div key={it.id} className={`ai-line${l.action === "IGNORE" ? " ignored" : ""}${low ? " low" : ""}`}>
                  <div className="ai-line-head">
                    <div>
                      <span className="app-sub">Línea {it.lineNo}{low ? " · lectura dudosa, verifique" : ""}</span>
                      <strong>{it.description}</strong>
                    </div>
                    <label className="set-check">
                      <input type="checkbox" checked={l.action === "RECEIVE"} onChange={(e) => update(i, { action: e.target.checked ? "RECEIVE" : "IGNORE" })} />
                      Ingresar
                    </label>
                  </div>
                  {l.action === "RECEIVE" && (
                    <div className="ai-line-grid">
                      <label className="set-field wide"><span>Producto del inventario {it.matchMethod !== "NONE" && it.matchedProductId && l.productId === it.matchedProductId ? `(sugerido por ${METHOD[it.matchMethod]})` : ""}</span>
                        <select value={l.productId} onChange={(e) => update(i, { productId: e.target.value })} aria-invalid={!l.productId}>
                          <option value="">— Seleccione —</option>
                          <option value="new">+ Crear producto nuevo</option>
                          {it.candidates.length > 0 && (
                            <optgroup label="Sugeridos">
                              {it.candidates.map((c) => <option key={c.productId} value={c.productId}>{productName.get(c.productId) ?? c.name} ({Math.round(c.score * 100)}%)</option>)}
                            </optgroup>
                          )}
                          <optgroup label="Todos los productos">
                            {products.map((p) => <option key={p.id} value={p.id}>{p.name} · {p.sku}</option>)}
                          </optgroup>
                        </select></label>
                      {l.productId === "new" && (
                        <>
                          <label className="set-field wide"><span>Nombre del producto nuevo *</span><input value={l.newName} onChange={(e) => update(i, { newName: e.target.value })} /></label>
                          <label className="set-field"><span>SKU *</span><input value={l.newSku} onChange={(e) => update(i, { newSku: e.target.value.toUpperCase() })} /></label>
                          <label className="set-field"><span>Precio de venta (con IGV) *</span><input inputMode="decimal" value={l.newPrice} onChange={(e) => update(i, { newPrice: e.target.value })} /></label>
                        </>
                      )}
                      <label className="set-field"><span>Cantidad *</span><input inputMode="decimal" value={l.quantity} onChange={(e) => update(i, { quantity: e.target.value })} /></label>
                      <label className="set-field"><span>Se compró por</span>
                        <select value={l.purchaseUnit} onChange={(e) => update(i, { purchaseUnit: e.target.value as "UNIT" | "PACKAGE" })}>
                          <option value="UNIT">Unidad</option><option value="PACKAGE">Caja / empaque</option>
                        </select></label>
                      {l.purchaseUnit === "PACKAGE" && (
                        <label className="set-field"><span>Unidades por empaque</span><input inputMode="numeric" value={l.unitsPerPackage} onChange={(e) => update(i, { unitsPerPackage: e.target.value.replace(/\D/g, "") })} /></label>
                      )}
                      <label className="set-field"><span>Costo unitario sin IGV *</span><input inputMode="decimal" value={l.unitCost} onChange={(e) => update(i, { unitCost: e.target.value })} /></label>
                      <label className="set-field"><span>Lote</span><input value={l.lot} onChange={(e) => update(i, { lot: e.target.value.toUpperCase() })} placeholder="Sin lote" /></label>
                      <label className="set-field"><span>Vencimiento</span><input type="date" value={l.expiry} onChange={(e) => update(i, { expiry: e.target.value })} /></label>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <footer className="ai-footer">
            <div><span className="app-muted">Subtotal sin IGV</span><strong>{h.currency === "USD" ? "US$" : "S/"} {subtotal.toLocaleString("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong></div>
            {error && <p className="set-msg bad" role="alert">{error}</p>}
            <div className="ai-drop-actions">
              <Link href="/app/purchases/ai" className="app-btn">Cancelar</Link>
              <button type="button" className="app-btn primary" onClick={approve} disabled={pending || receiving.length === 0}>
                {pending ? "Guardando…" : `Registrar compra e ingresar ${receiving.length} producto(s)`}
              </button>
            </div>
          </footer>
        </section>
      </div>
    </div>
  );
}
