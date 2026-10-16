"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CameraScanner } from "@/app/app/pos/_components/camera-scanner";
import { isValidGtin, looksLikeBrokenGtin } from "@/lib/inventory/barcode";
import { createProductAction } from "../actions";

const UNITS = [
  ["NIU", "Unidad"], ["KGM", "Kilogramo (a granel)"], ["GRM", "Gramo"], ["LTR", "Litro"], ["MLT", "Mililitro"],
  ["BX", "Caja"], ["BG", "Bolsa"], ["BO", "Botella"], ["SA", "Saco"], ["TAB", "Tableta"], ["AM", "Ampolla"], ["VI", "Vial"],
] as const;

const skuFrom = (name: string) =>
  name.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24);

export function ProductForm({ categories, branches, canAdjustStock, pharmacy, agro }: {
  categories: { id: string; name: string }[];
  branches: { id: string; name: string }[];
  canAdjustStock: boolean;
  pharmacy: boolean;
  agro: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const priceRef = useRef<HTMLInputElement>(null);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [skuTouched, setSkuTouched] = useState(false);
  const [v, setV] = useState({
    name: "", sku: "", barcode: "", category: categories[0]?.id ?? "__new", newCategory: "", salePrice: "",
    unitCode: "NIU", igvAffectation: "10", minStock: "", isService: false, allowFractional: false,
    sellByPackage: false, unitsPerPackage: "", packagePrice: "",
    senasaRegistration: "", withdrawalDaysMeat: "", withdrawalDaysMilk: "",
    dci: "", concentration: "", pharmaceuticalForm: "", laboratory: "", digemidRegistration: "",
    pharmaceuticalKind: "", saleCondition: "FREE", isControlled: false,
    withStock: false, branchId: branches[0]?.id ?? "", quantity: "", unitCost: "", lotCode: "", expiryDate: "",
  });
  const set = <K extends keyof typeof v>(k: K, val: (typeof v)[K]) => setV((p) => ({ ...p, [k]: val }));
  const intOrUndef = (s: string) => (s.trim() === "" ? undefined : Number(s));

  const code = v.barcode.trim();
  const codeHint = !code ? null : isValidGtin(code) ? { ok: true, text: "Código EAN/UPC válido" }
    : looksLikeBrokenGtin(code) ? { ok: false, text: "El dígito verificador no coincide: vuelva a escanear" } : { ok: true, text: "Código interno" };

  function onScanned(raw: string) {
    setScanning(false);
    const c = raw.trim();
    setV((p) => ({ ...p, barcode: c }));
    priceRef.current?.focus();
  }

  function submit(another: boolean) {
    setError(null);
    setNotice(null);
    start(async () => {
      const res = await createProductAction({
        name: v.name, sku: v.sku || skuFrom(v.name), barcode: v.barcode || undefined,
        categoryId: v.category !== "__new" && v.category !== "" ? v.category : undefined,
        newCategory: v.category === "__new" ? v.newCategory : undefined,
        salePrice: v.salePrice, unitCode: v.unitCode as never, igvAffectation: v.igvAffectation as "10" | "20" | "30",
        minStock: v.minStock || 0, isService: v.isService, allowFractional: v.allowFractional,
        unitsPerPackage: v.sellByPackage ? Number(v.unitsPerPackage) || 1 : 1, packagePrice: v.sellByPackage ? v.packagePrice || undefined : undefined,
        senasaRegistration: v.senasaRegistration, withdrawalDaysMeat: intOrUndef(v.withdrawalDaysMeat), withdrawalDaysMilk: intOrUndef(v.withdrawalDaysMilk),
        dci: v.dci, concentration: v.concentration, pharmaceuticalForm: v.pharmaceuticalForm, laboratory: v.laboratory,
        digemidRegistration: v.digemidRegistration, pharmaceuticalKind: (v.pharmaceuticalKind || undefined) as "GENERIC" | "BRAND" | undefined,
        saleCondition: pharmacy ? (v.saleCondition as "FREE") : undefined, isControlled: v.isControlled,
        initialStock: v.withStock && !v.isService ? {
          branchId: v.branchId, quantity: v.quantity, unitCost: v.unitCost || 0, lotCode: v.lotCode || undefined, expiryDate: v.expiryDate || undefined,
        } : undefined,
      });
      if (!res.ok) {
        const field = res.error.fieldErrors ? Object.values(res.error.fieldErrors).flat()[0] : undefined;
        setError(field ?? res.error.message);
        return;
      }
      const warn = res.data.warnings.length ? ` Atención: ${res.data.warnings.join(" ")}` : "";
      if (another) {
        setV((p) => ({ ...p, name: "", sku: "", barcode: "", salePrice: "", quantity: "", lotCode: "", expiryDate: "", unitCost: "" }));
        setSkuTouched(false);
        setNotice(`Producto ${res.data.sku} creado.${warn}`);
        window.scrollTo({ top: 0, behavior: "smooth" });
      } else {
        router.push(`/app/inventory?created=${encodeURIComponent(res.data.sku)}`);
      }
    });
  }

  return (
    <form className="app-stack" onSubmit={(e) => { e.preventDefault(); submit(false); }}>
      {notice && <p className="set-msg ok" role="status">{notice}</p>}

      <section className="app-panel">
        <header className="app-panel-head"><h2>Código de barras</h2><span className="app-sub">Opcional, recomendado para vender escaneando</span></header>
        <div className="set-form">
          <div className="set-field wide">
            <span>Código de barras / QR</span>
            <div className="pf-barcode">
              <input
                value={v.barcode} inputMode="text" autoComplete="off" placeholder="Escanee o escriba el código"
                onChange={(e) => set("barcode", e.target.value)}
                onKeyDown={(e) => {
                  // Un lector USB/Bluetooth termina con Enter: no enviar el formulario, pasar al precio
                  if (e.key === "Enter") { e.preventDefault(); priceRef.current?.focus(); }
                }}
                aria-describedby="barcode-hint"
              />
              <button type="button" className="app-btn primary" onClick={() => setScanning(true)}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
                  <path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2M7 8v8M10 8v8M13 8v8M16 8v8" />
                </svg>
                Escanear con cámara
              </button>
            </div>
            <small id="barcode-hint" className={codeHint && !codeHint.ok ? "bad" : undefined}>
              {codeHint?.text ?? "Con un lector USB/Bluetooth, haga clic en el campo y escanee."}
            </small>
          </div>
        </div>
      </section>

      <section className="app-panel">
        <header className="app-panel-head"><h2>Datos del producto</h2></header>
        <div className="set-form">
          <label className="set-field wide"><span>Nombre *</span>
            <input required minLength={2} value={v.name} placeholder="Ej. Ivermectina 1% inyectable 500 ml"
              onChange={(e) => { const name = e.target.value; setV((p) => ({ ...p, name, sku: skuTouched ? p.sku : skuFrom(name) })); }} /></label>
          <label className="set-field"><span>Categoría</span>
            <select value={v.category} onChange={(e) => set("category", e.target.value)}>
              {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              <option value="">Sin categoría</option>
              <option value="__new">+ Nueva categoría…</option>
            </select></label>
          {v.category === "__new" && (
            <label className="set-field"><span>Nombre de la nueva categoría</span>
              <input value={v.newCategory} onChange={(e) => set("newCategory", e.target.value)} placeholder="Ej. Antiparasitarios" /></label>
          )}
          <label className="set-field"><span>Precio de venta (con IGV) *</span>
            <input ref={priceRef} required inputMode="decimal" value={v.salePrice} placeholder="0.00" onChange={(e) => set("salePrice", e.target.value)} /></label>
          <label className="set-field"><span>SKU (código interno)</span>
            <input value={v.sku} onChange={(e) => { setSkuTouched(true); set("sku", e.target.value.toUpperCase()); }} />
            <small>Se genera del nombre; puede cambiarlo.</small></label>
          <label className="set-field"><span>Unidad</span>
            <select value={v.unitCode} onChange={(e) => set("unitCode", e.target.value)}>
              {UNITS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
            </select></label>
          <label className="set-field"><span>IGV</span>
            <select value={v.igvAffectation} onChange={(e) => set("igvAffectation", e.target.value)}>
              <option value="10">Gravado (18%)</option><option value="20">Exonerado</option><option value="30">Inafecto</option>
            </select></label>
          <label className="set-field"><span>Stock mínimo (alerta)</span>
            <input inputMode="decimal" value={v.minStock} placeholder="0" onChange={(e) => set("minStock", e.target.value)} /></label>
          <div className="set-field wide pf-checks">
            <label className="set-check"><input type="checkbox" checked={v.sellByPackage} onChange={(e) => set("sellByPackage", e.target.checked)} /> También se vende por caja / empaque</label>
            <label className="set-check"><input type="checkbox" checked={v.allowFractional} onChange={(e) => set("allowFractional", e.target.checked)} /> Se vende a granel (cantidades con decimales)</label>
            <label className="set-check"><input type="checkbox" checked={v.isService} onChange={(e) => set("isService", e.target.checked)} /> Es un servicio (sin stock: consulta, baño, aplicación)</label>
          </div>
          {v.sellByPackage && (
            <>
              <label className="set-field"><span>Unidades por empaque *</span>
                <input inputMode="numeric" value={v.unitsPerPackage} placeholder="Ej. 100" onChange={(e) => set("unitsPerPackage", e.target.value.replace(/\D/g, ""))} /></label>
              <label className="set-field"><span>Precio por empaque (con IGV) *</span>
                <input inputMode="decimal" value={v.packagePrice} onChange={(e) => set("packagePrice", e.target.value)} /></label>
            </>
          )}
        </div>
      </section>

      {agro && (
        <section className="app-panel">
          <header className="app-panel-head"><h2>Agro / Veterinaria</h2><span className="app-sub">Opcional</span></header>
          <div className="set-form">
            <label className="set-field"><span>Registro SENASA</span><input value={v.senasaRegistration} onChange={(e) => set("senasaRegistration", e.target.value)} /></label>
            <label className="set-field"><span>Retiro carne (días)</span><input inputMode="numeric" value={v.withdrawalDaysMeat} onChange={(e) => set("withdrawalDaysMeat", e.target.value.replace(/\D/g, ""))} /></label>
            <label className="set-field"><span>Retiro leche (días)</span><input inputMode="numeric" value={v.withdrawalDaysMilk} onChange={(e) => set("withdrawalDaysMilk", e.target.value.replace(/\D/g, ""))} /></label>
          </div>
        </section>
      )}

      {pharmacy && (
        <section className="app-panel">
          <header className="app-panel-head"><h2>Farmacia</h2><span className="app-sub">Para medicamentos</span></header>
          <div className="set-form">
            <label className="set-field"><span>DCI (principio activo)</span><input value={v.dci} onChange={(e) => set("dci", e.target.value)} placeholder="Ej. Paracetamol" /></label>
            <label className="set-field"><span>Concentración</span><input value={v.concentration} onChange={(e) => set("concentration", e.target.value)} placeholder="500 mg" /></label>
            <label className="set-field"><span>Forma farmacéutica</span><input value={v.pharmaceuticalForm} onChange={(e) => set("pharmaceuticalForm", e.target.value)} placeholder="Tableta" /></label>
            <label className="set-field"><span>Laboratorio</span><input value={v.laboratory} onChange={(e) => set("laboratory", e.target.value)} /></label>
            <label className="set-field"><span>Registro sanitario DIGEMID</span><input value={v.digemidRegistration} onChange={(e) => set("digemidRegistration", e.target.value)} /></label>
            <label className="set-field"><span>Tipo</span>
              <select value={v.pharmaceuticalKind} onChange={(e) => set("pharmaceuticalKind", e.target.value)}>
                <option value="">—</option><option value="GENERIC">Genérico</option><option value="BRAND">De marca</option>
              </select></label>
            <label className="set-field"><span>Condición de venta</span>
              <select value={v.saleCondition} onChange={(e) => set("saleCondition", e.target.value)}>
                <option value="FREE">Venta libre</option><option value="PRESCRIPTION">Con receta</option><option value="RETAINED_PRESCRIPTION">Receta retenida</option>
              </select></label>
            <label className="set-check"><input type="checkbox" checked={v.isControlled}
              onChange={(e) => setV((p) => ({ ...p, isControlled: e.target.checked, saleCondition: e.target.checked ? "RETAINED_PRESCRIPTION" : p.saleCondition }))} /> Producto controlado (libro de control)</label>
          </div>
        </section>
      )}

      {canAdjustStock && !v.isService && branches.length > 0 && (
        <section className="app-panel">
          <header className="app-panel-head">
            <div><h2>Stock inicial</h2><span className="app-sub">Opcional: si ya tiene unidades en tienda. Las siguientes entradas, por Compras.</span></div>
            <label className="set-switch"><input type="checkbox" checked={v.withStock} onChange={(e) => set("withStock", e.target.checked)} /><span>{v.withStock ? "Registrar" : "No"}</span></label>
          </header>
          {v.withStock && (
            <div className="set-form">
              {branches.length > 1 && (
                <label className="set-field"><span>Sucursal</span>
                  <select value={v.branchId} onChange={(e) => set("branchId", e.target.value)}>{branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></label>
              )}
              <label className="set-field"><span>Cantidad (unidad base) *</span><input inputMode="decimal" value={v.quantity} onChange={(e) => set("quantity", e.target.value)} /></label>
              <label className="set-field"><span>Costo unitario sin IGV</span><input inputMode="decimal" value={v.unitCost} placeholder="0.00" onChange={(e) => set("unitCost", e.target.value)} /></label>
              <label className="set-field"><span>Lote</span><input value={v.lotCode} onChange={(e) => set("lotCode", e.target.value.toUpperCase())} placeholder="Sin lote" /></label>
              <label className="set-field"><span>Vencimiento</span><input type="date" value={v.expiryDate} onChange={(e) => set("expiryDate", e.target.value)} /></label>
            </div>
          )}
        </section>
      )}

      {error && <p className="set-msg bad" role="alert">{error}</p>}
      <div className="pf-actions">
        <button type="button" className="app-btn" disabled={pending} onClick={() => submit(true)}>Guardar y agregar otro</button>
        <button type="submit" className="app-btn primary" disabled={pending}>{pending ? "Guardando…" : "Guardar producto"}</button>
      </div>

      {scanning && <CameraScanner onDetected={onScanned} onClose={() => setScanning(false)} />}
    </form>
  );
}
