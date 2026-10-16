"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createSaleAction } from "@/app/app/pos/actions";
import type { PosProduct } from "@/lib/inventory/pos-catalog";
import { Icon } from "@/app/app/_components/icons";
import { CameraScanner } from "./camera-scanner";
import { useHardwareScanner } from "./use-hardware-scanner";

type SaleUnit = "UNIT" | "PACKAGE";
type DocType = "BOLETA" | "FACTURA";
type Method = "EFECTIVO" | "YAPE" | "PLIN" | "TARJETA" | "TRANSFERENCIA";

interface CartLine {
  key: string;
  product: PosProduct;
  unit: SaleUnit;
  qty: number;
}

interface Receipt {
  number: string;
  total: string;
  change: number | null;
  warnings: string[];
}

const METHODS: { key: Method; label: string }[] = [
  { key: "EFECTIVO", label: "Efectivo" },
  { key: "YAPE", label: "Yape" },
  { key: "PLIN", label: "Plin" },
  { key: "TARJETA", label: "Tarjeta" },
  { key: "TRANSFERENCIA", label: "Transferencia" },
];

const money = (n: number) => `S/ ${n.toLocaleString("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

function unitPrice(p: PosProduct, unit: SaleUnit): number {
  if (unit === "PACKAGE") return p.packagePrice ? Number(p.packagePrice) : Number(p.salePrice) * p.unitsPerPackage;
  return Number(p.salePrice);
}
const baseQty = (l: CartLine) => (l.unit === "PACKAGE" ? l.qty * l.product.unitsPerPackage : l.qty);
const lineTotal = (l: CartLine) => Math.round(unitPrice(l.product, l.unit) * l.qty * 100) / 100;
const isGravado = (p: PosProduct) => p.igvAffectation.startsWith("1");

export function Pos({ products, branchId, branchName, series }: {
  products: PosProduct[];
  branchId: string;
  branchName: string;
  series: { BOLETA: string | null; FACTURA: string | null };
}) {
  const router = useRouter();
  const searchRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [cart, setCart] = useState<CartLine[]>([]);
  const [docType, setDocType] = useState<DocType>("BOLETA");
  const [custDoc, setCustDoc] = useState("");
  const [custName, setCustName] = useState("");
  const [custAddress, setCustAddress] = useState("");
  const [method, setMethod] = useState<Method>("EFECTIVO");
  const [received, setReceived] = useState("");
  const [toast, setToast] = useState<{ text: string; tone: "ok" | "bad" } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [scanning, setScanning] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [pending, startTransition] = useTransition();
  const idempotencyKey = useRef<string>(crypto.randomUUID());
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flash = (text: string, tone: "ok" | "bad" = "ok") => {
    setToast({ text, tone });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2200);
  };

  const byCode = useMemo(() => {
    const m = new Map<string, PosProduct>();
    for (const p of products) {
      if (p.barcode) m.set(p.barcode.toLowerCase(), p);
      m.set(p.sku.toLowerCase(), p);
    }
    return m;
  }, [products]);

  const results = useMemo(() => {
    const q = norm(query.trim());
    if (!q) return products;
    return products.filter((p) => norm(`${p.name} ${p.dci ?? ""} ${p.sku} ${p.barcode ?? ""}`).includes(q));
  }, [products, query]);

  const available = (p: PosProduct) => Number(p.available);
  const inCartBase = (productId: string, except?: string) =>
    cart.filter((l) => l.product.id === productId && l.key !== except).reduce((a, l) => a + baseQty(l), 0);

  function add(p: PosProduct, unit: SaleUnit = "UNIT") {
    if (p.requiresRx) {
      flash(`${p.name} requiere receta: dispénselo desde Farmacia`, "bad");
      return;
    }
    const step = unit === "PACKAGE" ? p.unitsPerPackage : 1;
    if (p.tracksBatches && !p.isService && inCartBase(p.id) + step > available(p)) {
      flash(`Sin stock suficiente de ${p.name}`, "bad");
      return;
    }
    setCart((prev) => {
      const existing = prev.find((l) => l.product.id === p.id && l.unit === unit);
      if (existing) return prev.map((l) => (l === existing ? { ...l, qty: l.qty + 1 } : l));
      return [...prev, { key: `${p.id}:${unit}`, product: p, unit, qty: 1 }];
    });
    flash(`+1 ${p.name}`);
  }

  function setQty(line: CartLine, qty: number) {
    if (qty <= 0) return setCart((prev) => prev.filter((l) => l.key !== line.key));
    const base = line.unit === "PACKAGE" ? qty * line.product.unitsPerPackage : qty;
    if (line.product.tracksBatches && !line.product.isService && inCartBase(line.product.id, line.key) + base > available(line.product)) {
      flash("No hay más stock disponible", "bad");
      return;
    }
    setCart((prev) => prev.map((l) => (l.key === line.key ? { ...l, qty } : l)));
  }

  function toggleUnit(line: CartLine) {
    const unit: SaleUnit = line.unit === "UNIT" ? "PACKAGE" : "UNIT";
    setCart((prev) => {
      const without = prev.filter((l) => l.key !== line.key);
      const merged = without.find((l) => l.product.id === line.product.id && l.unit === unit);
      if (merged) return without.map((l) => (l === merged ? { ...l, qty: l.qty + 1 } : l));
      return [...without, { key: `${line.product.id}:${unit}`, product: line.product, unit, qty: 1 }];
    });
  }

  /** Código de lector físico o cámara: coincidencia exacta por código de barras o SKU. */
  function handleCode(raw: string) {
    const p = byCode.get(raw.trim().toLowerCase());
    if (p) add(p);
    else flash(`Código ${raw} no encontrado`, "bad");
  }
  useHardwareScanner(handleCode, !receipt && !scanning);

  function onSearchKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const q = query.trim();
    if (!q) return;
    const exact = byCode.get(q.toLowerCase());
    if (exact) add(exact);
    else if (results.length === 1) add(results[0]!);
    else return;
    setQuery("");
  }

  const total = cart.reduce((a, l) => a + lineTotal(l), 0);
  const igv = cart.reduce((a, l) => a + (isGravado(l.product) ? lineTotal(l) - lineTotal(l) / 1.18 : 0), 0);
  const items = cart.reduce((a, l) => a + l.qty, 0);
  const receivedN = Number(received.replace(",", "."));
  const change = method === "EFECTIVO" && received ? receivedN - total : null;
  const needsId = docType === "BOLETA" && total > 700;
  const currentSeries = series[docType];

  function resetSale() {
    setCart([]);
    setCustDoc("");
    setCustName("");
    setCustAddress("");
    setReceived("");
    setMethod("EFECTIVO");
    setError(null);
    setReceipt(null);
    setSheet(false);
    idempotencyKey.current = crypto.randomUUID();
    searchRef.current?.focus();
  }

  function checkout() {
    setError(null);
    if (!currentSeries) return setError(`No hay serie activa de ${docType === "BOLETA" ? "boleta" : "factura"} en esta sucursal.`);
    if (cart.length === 0) return setError("Agregue productos al carrito.");
    if (docType === "FACTURA" && !/^\d{11}$/.test(custDoc)) return setError("La factura requiere el RUC (11 dígitos) del cliente.");
    if (docType === "FACTURA" && custName.trim().length < 3) return setError("Ingrese la razón social del cliente.");
    if (docType === "BOLETA" && custDoc && !/^\d{8}$/.test(custDoc)) return setError("El DNI debe tener 8 dígitos.");
    if (needsId && !custDoc) return setError("Boletas mayores a S/ 700 requieren el DNI del cliente.");
    if (change !== null && change < 0) return setError("El monto recibido es menor al total.");

    const customer =
      docType === "FACTURA"
        ? { docType: "RUC" as const, docNumber: custDoc, name: custName.trim(), address: custAddress.trim() || undefined }
        : custDoc
          ? { docType: "DNI" as const, docNumber: custDoc, name: custName.trim() || "CLIENTE" }
          : { docType: "NO_DOC" as const, docNumber: "-", name: "CLIENTES VARIOS" };

    startTransition(async () => {
      const input = {
        idempotencyKey: idempotencyKey.current,
        branchId,
        docType,
        series: currentSeries,
        customer,
        items: cart.map((l) => ({ productId: l.product.id, saleUnit: l.unit, quantity: l.qty })),
        payments: [{ method, amount: total.toFixed(2) }],
        paymentTerms: "Contado" as const,
      };
      let res = await createSaleAction(input);
      // Contención en caja: reintento seguro con la MISMA clave (no duplica la venta)
      if (!res.ok && res.error.code === "BUSY_RETRY") res = await createSaleAction(input);
      if (!res.ok) {
        setError(res.error.message);
        return;
      }
      setReceipt({
        number: `${res.data.series}-${res.data.number}`,
        total: res.data.total,
        change: change !== null && change > 0 ? change : null,
        warnings: res.data.warnings,
      });
      setSheet(false);
      router.refresh(); // stock actualizado
    });
  }

  const cartPanel = (
    <>
      <div className="pos-cart-head">
        <h2>Venta actual</h2>
        {cart.length > 0 && <button type="button" className="pos-link" onClick={() => setCart([])}>Vaciar</button>}
      </div>

      <div className="pos-lines">
        {cart.length === 0 && <p className="pos-empty">Escanee o toque un producto para agregarlo.</p>}
        {cart.map((l) => (
          <div key={l.key} className="pos-line">
            <div className="pos-line-info">
              <strong>{l.product.name}</strong>
              <span>
                {money(unitPrice(l.product, l.unit))} / {l.unit === "PACKAGE" ? `empaque x${l.product.unitsPerPackage}` : "unidad"}
                {l.product.unitsPerPackage > 1 && (
                  <button type="button" className="pos-link" onClick={() => toggleUnit(l)}>
                    {l.unit === "UNIT" ? "· vender por empaque" : "· vender por unidad"}
                  </button>
                )}
              </span>
            </div>
            <div className="pos-qty">
              <button type="button" aria-label="Quitar uno" onClick={() => setQty(l, l.qty - 1)}>−</button>
              <input
                inputMode="numeric" value={l.qty} aria-label={`Cantidad de ${l.product.name}`}
                onChange={(e) => { const n = Number(e.target.value.replace(/\D/g, "")); if (!Number.isNaN(n)) setQty(l, n); }}
              />
              <button type="button" aria-label="Agregar uno" onClick={() => setQty(l, l.qty + 1)}>+</button>
            </div>
            <strong className="pos-line-total">{money(lineTotal(l))}</strong>
          </div>
        ))}
      </div>

      <div className="pos-checkout">
        <div className="pos-seg" role="radiogroup" aria-label="Tipo de comprobante">
          {(["BOLETA", "FACTURA"] as const).map((d) => (
            <button key={d} type="button" role="radio" aria-checked={docType === d} className={docType === d ? "on" : ""}
              onClick={() => { setDocType(d); setCustDoc(""); setCustName(""); }}>
              {d === "BOLETA" ? "Boleta" : "Factura"}
            </button>
          ))}
        </div>

        <div className="pos-fields">
          <input
            inputMode="numeric" maxLength={docType === "FACTURA" ? 11 : 8} value={custDoc}
            placeholder={docType === "FACTURA" ? "RUC del cliente *" : needsId ? "DNI del cliente *" : "DNI (opcional)"}
            onChange={(e) => setCustDoc(e.target.value.replace(/\D/g, ""))} aria-label="Documento del cliente"
          />
          {(docType === "FACTURA" || custDoc) && (
            <input value={custName} onChange={(e) => setCustName(e.target.value)}
              placeholder={docType === "FACTURA" ? "Razón social *" : "Nombre del cliente"} aria-label="Nombre del cliente" />
          )}
          {docType === "FACTURA" && (
            <input value={custAddress} onChange={(e) => setCustAddress(e.target.value)} placeholder="Dirección (opcional)" aria-label="Dirección" />
          )}
        </div>

        <div className="pos-methods" role="radiogroup" aria-label="Medio de pago">
          {METHODS.map((m) => (
            <button key={m.key} type="button" role="radio" aria-checked={method === m.key} className={method === m.key ? "on" : ""}
              onClick={() => setMethod(m.key)}>{m.label}</button>
          ))}
        </div>
        {method === "EFECTIVO" && (
          <div className="pos-cash">
            <input inputMode="decimal" value={received} onChange={(e) => setReceived(e.target.value)} placeholder="Monto recibido" aria-label="Monto recibido" />
            <span className={change !== null && change < 0 ? "bad" : ""}>
              Vuelto: <strong>{change === null ? "—" : money(Math.max(change, 0))}</strong>
            </span>
          </div>
        )}

        <dl className="pos-totals">
          <div><dt>Op. gravadas + exoneradas</dt><dd>{money(total - igv)}</dd></div>
          <div><dt>IGV (18%)</dt><dd>{money(igv)}</dd></div>
          <div className="grand"><dt>Total</dt><dd>{money(total)}</dd></div>
        </dl>

        {error && <p className="pos-error" role="alert">{error}</p>}
        <button type="button" className="pos-pay" disabled={pending || cart.length === 0} onClick={checkout}>
          {pending ? "Emitiendo…" : `Cobrar ${money(total)}`}
        </button>
        <p className="pos-series">{docType === "BOLETA" ? "Boleta" : "Factura"} serie {currentSeries ?? "—"} · {branchName}</p>
      </div>
    </>
  );

  return (
    <div className="pos">
      <section className="pos-catalog" aria-label="Productos">
        <div className="pos-search">
          <Icon name="box" size={18} />
          <input
            ref={searchRef} autoFocus value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={onSearchKey}
            placeholder="Buscar por nombre, DCI, código o escanear…" aria-label="Buscar producto o escanear código"
            enterKeyHint="search" autoComplete="off"
          />
          <button type="button" className="pos-cam" onClick={() => setScanning(true)} aria-label="Escanear con la cámara">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
              <path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2M7 8v8M10 8v8M13 8v8M16 8v8" />
            </svg>
            <span>Cámara</span>
          </button>
        </div>
        <p className="pos-hint">Lector de códigos USB o Bluetooth: escanee directamente, sin hacer clic.</p>

        <div className="pos-grid">
          {results.length === 0 && <p className="pos-empty">Sin resultados para «{query}».</p>}
          {results.map((p) => {
            const stock = available(p);
            const out = p.tracksBatches && !p.isService && stock <= 0;
            return (
              <div key={p.id} className={`pos-card${out || p.requiresRx ? " muted" : ""}`}>
                <button type="button" className="pos-card-main" onClick={() => add(p)} disabled={out}
                  aria-label={`Agregar ${p.name}, ${money(Number(p.salePrice))}`}>
                  <span className="pos-card-name">{p.name}</span>
                  {p.dci && <span className="pos-card-sub">{p.dci}</span>}
                  <span className="pos-card-price">{money(Number(p.salePrice))}</span>
                  <span className="pos-card-meta">
                    {out ? <span className="app-pill red">Agotado</span> : p.isService ? <span className="app-pill gray">Servicio</span>
                      : <span className={`app-pill ${stock < 10 ? "amber" : "green"}`}>Stock {stock}</span>}
                    {p.requiresRx && <span className="app-pill red">Receta</span>}
                  </span>
                </button>
                {p.unitsPerPackage > 1 && !out && !p.requiresRx && (
                  <button type="button" className="pos-pack" onClick={() => add(p, "PACKAGE")}>
                    + empaque x{p.unitsPerPackage} · {money(unitPrice(p, "PACKAGE"))}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </section>

      <aside className={`pos-cart${sheet ? " open" : ""}`} aria-label="Carrito">
        <button type="button" className="pos-sheet-close" onClick={() => setSheet(false)} aria-label="Cerrar carrito">⌄</button>
        {cartPanel}
      </aside>

      {/* Barra inferior móvil */}
      <button type="button" className="pos-bar" onClick={() => setSheet(true)} disabled={cart.length === 0}>
        <span>{items} {items === 1 ? "producto" : "productos"}</span>
        <strong>Cobrar {money(total)}</strong>
      </button>

      {toast && <div className={`pos-toast ${toast.tone}`} role="status">{toast.text}</div>}
      {scanning && <CameraScanner onDetected={handleCode} onClose={() => { setScanning(false); searchRef.current?.focus(); }} />}

      {receipt && (
        <div className="pos-overlay" role="dialog" aria-modal="true" aria-labelledby="receipt-title">
          <div className="pos-receipt">
            <span className="pos-receipt-ok" aria-hidden>✓</span>
            <h2 id="receipt-title">Venta registrada</h2>
            <p className="pos-receipt-num">{receipt.number}</p>
            <p className="pos-receipt-total">S/ {receipt.total}</p>
            {receipt.change !== null && <p>Vuelto: <strong>{money(receipt.change)}</strong></p>}
            {receipt.warnings.map((w) => <p key={w} className="pos-warning">{w}</p>)}
            <p className="pos-receipt-note">El comprobante se envía a SUNAT automáticamente; su estado aparece en Comprobantes.</p>
            <button type="button" className="pos-pay" onClick={resetSale} autoFocus>Nueva venta</button>
          </div>
        </div>
      )}
    </div>
  );
}
