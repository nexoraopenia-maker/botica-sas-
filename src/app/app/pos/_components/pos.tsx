"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createSaleAction, walletBalanceAction } from "@/app/app/pos/actions";
import { expiryWarning } from "@/lib/inventory/expiry-rules";
import { findSubstitutes, matchesSearch } from "@/lib/pharmacy/substitutes";
import { categoryOptions, inCategory, NO_CATEGORY } from "@/lib/inventory/pos-categories";
import { ICBPER_PER_BAG } from "@/lib/sunat/rates";
import type { PosProduct } from "@/lib/inventory/pos-catalog";
import { Icon } from "@/app/app/_components/icons";
import { CameraScanner } from "./camera-scanner";
import { useHardwareScanner } from "./use-hardware-scanner";
import { CashClosureModal } from "./cash-closure-modal";
import { PrescriptionForm } from "@/app/app/pharmacy/_components/prescription-form";

type SaleUnit = "UNIT" | "BLISTER" | "PACKAGE";
type DocType = "BOLETA" | "FACTURA";
type Method = "EFECTIVO" | "YAPE" | "PLIN" | "TARJETA" | "TRANSFERENCIA";

interface CartLine {
  key: string;
  product: PosProduct;
  unit: SaleUnit;
  qty: number;
  /** Receta ya validada (obligatoria en productos con receta o controlados) */
  prescriptionId?: string;
}

interface Receipt {
  number: string;
  total: string;
  igv: string;
  icbper: string;
  change: number | null;
  warnings: string[];
  wallet: { redeemed: string; earned: string; balance: string } | null;
}

const METHODS: { key: Method; label: string }[] = [
  { key: "EFECTIVO", label: "Efectivo" },
  { key: "YAPE", label: "Yape" },
  { key: "PLIN", label: "Plin" },
  { key: "TARJETA", label: "Tarjeta" },
  { key: "TRANSFERENCIA", label: "Transferencia" },
];

const money = (n: number) => `S/ ${n.toLocaleString("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const ICBPER = Number(ICBPER_PER_BAG);

function unitPrice(p: PosProduct, unit: SaleUnit): number {
  if (unit === "BLISTER") return p.blisterPrice ? Number(p.blisterPrice) : Number(p.salePrice) * p.unitsPerBlister;
  if (unit === "PACKAGE") return p.packagePrice ? Number(p.packagePrice) : Number(p.salePrice) * p.unitsPerPackage;
  return Number(p.salePrice);
}
/** Unidades base que descuenta una unidad de venta: el kardex siempre va en unidad base. */
const factor = (p: PosProduct, unit: SaleUnit) => (unit === "PACKAGE" ? p.unitsPerPackage : unit === "BLISTER" ? p.unitsPerBlister : 1);
const baseQty = (l: CartLine) => l.qty * factor(l.product, l.unit);
/** Presentaciones en que se vende el producto, de menor a mayor. */
const presentations = (p: PosProduct): SaleUnit[] => [
  "UNIT",
  ...(p.unitsPerBlister > 1 ? (["BLISTER"] as const) : []),
  ...(p.unitsPerPackage > 1 ? (["PACKAGE"] as const) : []),
];
const unitLabel = (p: PosProduct, unit: SaleUnit) =>
  unit === "PACKAGE" ? `caja x${p.unitsPerPackage}` : unit === "BLISTER" ? `blíster x${p.unitsPerBlister}` : (p.baseUnitName?.toLowerCase() ?? "unidad");
const lineTotal = (l: CartLine) => Math.round(unitPrice(l.product, l.unit) * l.qty * 100) / 100;
/** Bolsas plásticas de la línea: el ICBPER se paga por bolsa, aunque se venda un paquete */
const bagsOf = (l: CartLine) => (l.product.icbper ? baseQty(l) : 0);
const isGravado = (p: PosProduct) => p.igvAffectation.startsWith("1");
/** Texto del periodo de retiro para el aviso rojo al productor. */
const withdrawalText = (p: PosProduct) => [
  p.withdrawalMeat ? `carne ${p.withdrawalMeat} días` : null,
  p.withdrawalMilk ? `leche ${p.withdrawalMilk} días` : null,
].filter(Boolean).join(" · ");

export function Pos({ products, branchId, branchName, series, otcOnly = false, canDispenseRx = false, today, sellers, currentUserId, loyaltyEnabled }: {
  products: PosProduct[];
  branchId: string;
  branchName: string;
  series: { BOLETA: string | null; FACTURA: string | null };
  otcOnly?: boolean;
  canDispenseRx?: boolean;
  today: string;
  sellers: { id: string; name: string }[];
  currentUserId: string;
  loyaltyEnabled: boolean;
}) {
  const router = useRouter();
  const searchRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  /** null = todas las categorías */
  const [category, setCategory] = useState<string | null>(null);
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
  const [closing, setClosing] = useState(false);
  const [sellerId, setSellerId] = useState(currentUserId);
  const [walletBalance, setWalletBalance] = useState<number | null>(null);
  const [walletUse, setWalletUse] = useState("");
  const [rxFor, setRxFor] = useState<{ product: PosProduct; unit: SaleUnit } | null>(null);
  /** Medicamento de marca recién agregado: se le sugieren genéricos y sustitutos */
  const [subsFor, setSubsFor] = useState<string | null>(null);
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

  const pool = useMemo(() => (otcOnly ? products.filter((p) => !p.requiresRx) : products), [products, otcOnly]);
  const cats = useMemo(() => categoryOptions(pool), [pool]);
  // Si la categoría elegida ya no tiene productos (venta rápida, catálogo actualizado), se vuelve a «Todas»
  const activeCategory = category !== null && category !== NO_CATEGORY && !cats.options.some((o) => o.id === category) ? null : category;
  const results = useMemo(() => {
    const q = query.trim();
    const inCat = activeCategory === null ? pool : pool.filter((p) => inCategory(p, activeCategory));
    return q ? inCat.filter((p) => matchesSearch(p, q)) : inCat;
  }, [pool, query, activeCategory]);

  const available = (p: PosProduct) => Number(p.available);
  const inCartBase = (productId: string, except?: string) =>
    cart.filter((l) => l.product.id === productId && l.key !== except).reduce((a, l) => a + baseQty(l), 0);

  function add(p: PosProduct, unit: SaleUnit = "UNIT", prescriptionId?: string) {
    // Receta: se exige antes de que el producto entre al carrito, una por producto
    const rx = prescriptionId ?? cart.find((l) => l.product.id === p.id)?.prescriptionId;
    if (p.requiresRx && !rx) {
      if (!canDispenseRx) {
        flash(`${p.name} requiere receta: solo puede dispensarlo el químico farmacéutico`, "bad");
        return;
      }
      setRxFor({ product: p, unit });
      return;
    }
    const step = factor(p, unit);
    if (p.tracksBatches && !p.isService && inCartBase(p.id) + step > available(p)) {
      flash(`Sin stock suficiente de ${p.name}`, "bad");
      return;
    }
    setCart((prev) => {
      const existing = prev.find((l) => l.product.id === p.id && l.unit === unit);
      if (existing) return prev.map((l) => (l === existing ? { ...l, qty: l.qty + 1 } : l));
      return [...prev, { key: `${p.id}:${unit}`, product: p, unit, qty: 1, prescriptionId: rx }];
    });
    flash(`+1 ${unit === "UNIT" ? "" : `${unitLabel(p, unit)} · `}${p.name}`);
    if (p.dci && p.pharmaceuticalKind !== "GENERIC") setSubsFor(p.id);
  }

  /** Reemplaza el medicamento del carrito por un equivalente, con la misma cantidad y presentación si existe. */
  function swap(from: PosProduct, to: PosProduct) {
    const line = cart.find((l) => l.product.id === from.id);
    if (!line) return;
    setSubsFor(null);
    if (to.requiresRx) {
      // La receta validada es del producto original: el sustituto pide la suya
      setCart((prev) => prev.filter((l) => l.key !== line.key));
      add(to);
      return;
    }
    const unit = presentations(to).includes(line.unit) ? line.unit : "UNIT";
    if (to.tracksBatches && !to.isService && inCartBase(to.id) + line.qty * factor(to, unit) > available(to)) {
      flash(`No hay stock suficiente de ${to.name}`, "bad");
      return;
    }
    setCart((prev) => {
      const without = prev.filter((l) => l.key !== line.key);
      const merged = without.find((l) => l.product.id === to.id && l.unit === unit);
      if (merged) return without.map((l) => (l === merged ? { ...l, qty: l.qty + line.qty } : l));
      return [...without, { key: `${to.id}:${unit}`, product: to, unit, qty: line.qty }];
    });
    flash(`Cambiado por ${to.name}`);
  }

  function setQty(line: CartLine, qty: number) {
    if (qty <= 0) return setCart((prev) => prev.filter((l) => l.key !== line.key));
    const base = qty * factor(line.product, line.unit);
    if (line.product.tracksBatches && !line.product.isService && inCartBase(line.product.id, line.key) + base > available(line.product)) {
      flash("No hay más stock disponible", "bad");
      return;
    }
    setCart((prev) => prev.map((l) => (l.key === line.key ? { ...l, qty } : l)));
  }

  /** Cambia la presentación de la línea (pastilla → blíster → caja), si hay stock para ella. */
  function setLineUnit(line: CartLine, unit: SaleUnit) {
    if (unit === line.unit) return;
    const p = line.product;
    if (p.tracksBatches && !p.isService && inCartBase(p.id, line.key) + factor(p, unit) > available(p)) {
      flash("No hay stock suficiente para esa presentación", "bad");
      return;
    }
    setCart((prev) => {
      const without = prev.filter((l) => l.key !== line.key);
      const merged = without.find((l) => l.product.id === p.id && l.unit === unit);
      if (merged) return without.map((l) => (l === merged ? { ...l, qty: l.qty + 1 } : l));
      return [...without, { key: `${p.id}:${unit}`, product: p, unit, qty: 1, prescriptionId: line.prescriptionId }];
    });
  }

  /** Código de lector físico o cámara: coincidencia exacta por código de barras o SKU. */
  function handleCode(raw: string) {
    const p = byCode.get(raw.trim().toLowerCase());
    if (p) add(p);
    else flash(`Código ${raw} no encontrado`, "bad");
  }
  useHardwareScanner(handleCode, !receipt && !scanning && !rxFor && !closing);

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

  const bags = cart.reduce((a, l) => a + bagsOf(l), 0);
  const icbper = Math.round(bags * ICBPER * 100) / 100;
  const total = Math.round((cart.reduce((a, l) => a + lineTotal(l), 0) + icbper) * 100) / 100;
  const igv = cart.reduce((a, l) => a + (isGravado(l.product) ? lineTotal(l) - lineTotal(l) / 1.18 : 0), 0);
  const items = cart.reduce((a, l) => a + l.qty, 0);
  const receivedN = Number(received.replace(",", "."));
  const walletAmount = Math.min(Math.max(Number(walletUse.replace(",", ".")) || 0, 0), walletBalance ?? 0, total);
  const toPay = Math.round((total - walletAmount) * 100) / 100;
  const change = method === "EFECTIVO" && received ? receivedN - toPay : null;
  const needsId = docType === "BOLETA" && total > 700;
  const currentSeries = series[docType];
  const expiringLines = [...new Map(cart.map((l) => [l.product.id, l.product])).values()]
    .map((p) => ({ p, warn: expiryWarning(p.nearestExpiry, today) })).filter((x) => x.warn);
  // Saldo del monedero al identificar al cliente
  useEffect(() => {
    setWalletBalance(null);
    setWalletUse("");
    const type = docType === "FACTURA" ? "RUC" : "DNI";
    if (!loyaltyEnabled || custDoc.length !== (type === "RUC" ? 11 : 8)) return;
    let stale = false;
    void walletBalanceAction(type, custDoc).then((r) => { if (!stale && r.ok && r.data.balance !== null) setWalletBalance(Number(r.data.balance)); });
    return () => { stale = true; };
  }, [custDoc, docType, loyaltyEnabled]);
  const bagProduct = products.find((p) => p.icbper && !p.isService);
  const bagLine = bagProduct ? cart.find((l) => l.product.id === bagProduct.id && l.unit === "UNIT") : undefined;
  const subsProduct = subsFor ? cart.find((l) => l.product.id === subsFor)?.product : undefined;
  const substitutes = subsProduct ? findSubstitutes(subsProduct, otcOnly ? products.filter((p) => !p.requiresRx) : products) : [];
  const withdrawalLines = [...new Map(cart.filter((l) => l.product.withdrawalDays).map((l) => [l.product.id, l.product])).values()];

  function resetSale() {
    setCart([]);
    setCustDoc("");
    setCustName("");
    setCustAddress("");
    setReceived("");
    setMethod("EFECTIVO");
    setWalletBalance(null);
    setWalletUse("");
    setSubsFor(null);
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
        items: cart.map((l) => ({ productId: l.product.id, saleUnit: l.unit, quantity: l.qty, prescriptionId: l.prescriptionId })),
        sellerId,
        payments: [
          ...(walletAmount > 0 ? [{ method: "MONEDERO" as const, amount: walletAmount.toFixed(2) }] : []),
          ...(toPay > 0 ? [{ method, amount: toPay.toFixed(2) }] : []),
        ],
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
        igv: res.data.igv,
        icbper: res.data.icbper,
        change: change !== null && change > 0 ? change : null,
        warnings: res.data.warnings,
        wallet: res.data.wallet ?? null,
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
                {money(unitPrice(l.product, l.unit))} / {unitLabel(l.product, l.unit)}
                {presentations(l.product).length > 1 && (
                  <select className="pos-unit" aria-label={`Presentación de ${l.product.name}`} value={l.unit} onChange={(e) => setLineUnit(l, e.target.value as SaleUnit)}>
                    {presentations(l.product).map((u) => <option key={u} value={u}>{unitLabel(l.product, u)}</option>)}
                  </select>
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
            {l.prescriptionId && <span className="pos-rx-ok">Receta validada</span>}
          </div>
        ))}
      </div>

      {subsProduct && substitutes.length > 0 && (
        <div className="pos-subs" role="region" aria-label={`Genéricos y sustitutos de ${subsProduct.name}`}>
          <div className="pos-subs-head">
            <div><strong>Genéricos y sustitutos</strong><small>Mismo principio activo, concentración y forma que {subsProduct.name}</small></div>
            <button type="button" className="pos-link" onClick={() => setSubsFor(null)} aria-label="Ocultar sugerencias">Ocultar</button>
          </div>
          {substitutes.map(({ product: s, saving }) => (
            <div key={s.id} className="pos-sub">
              <div className="pos-sub-info">
                <strong>{s.name}</strong>
                <span>
                  {s.pharmaceuticalKind === "GENERIC" && <span className="app-pill green">Genérico</span>}
                  {s.laboratory && <span>{s.laboratory}</span>}
                  <span>{money(Number(s.salePrice))}</span>
                  {saving > 0 && <span className="pos-sub-save">Ahorra {money(saving)} c/u</span>}
                </span>
              </div>
              <button type="button" className="app-btn" onClick={() => swap(subsProduct, s)}>Cambiar</button>
            </div>
          ))}
        </div>
      )}

      {expiringLines.length > 0 && (
        <div className="pos-callout amber" role="status">
          <strong>Lote próximo a vencer</strong>
          {expiringLines.map(({ p, warn }) => <p key={p.id}>{p.name}: {warn!.label.toLowerCase()} ({p.nearestExpiry}). Verifique el lote y avise al cliente.</p>)}
        </div>
      )}

      {withdrawalLines.length > 0 && (
        <div className="pos-callout" role="alert">
          <strong>Periodo de retiro: avise al productor</strong>
          {withdrawalLines.map((p) => (
            <p key={p.id}>{p.name}: esperar {withdrawalText(p)} antes del consumo humano.</p>
          ))}
        </div>
      )}

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

        {walletBalance !== null && (
          <div className="pos-wallet">
            <span>Monedero: <strong>{money(walletBalance)}</strong></span>
            {walletBalance > 0 && (
              <>
                <input inputMode="decimal" aria-label="Monto a pagar con monedero" placeholder="Usar" value={walletUse} onChange={(e) => setWalletUse(e.target.value)} />
                <button type="button" className="pos-link" onClick={() => setWalletUse(Math.min(walletBalance, total).toFixed(2))}>Usar todo</button>
              </>
            )}
          </div>
        )}

        {sellers.length > 1 && (
          <label className="pos-seller"><span>Vendedor</span>
            <select value={sellerId} onChange={(e) => setSellerId(e.target.value)}>
              {!sellers.some((s) => s.id === currentUserId) && <option value={currentUserId}>Usuario actual</option>}
              {sellers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
        )}

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

        {bagProduct && (
          <div className="pos-bags">
            <span>Bolsas plásticas<small>{money(Number(bagProduct.salePrice))} + ICBPER {money(ICBPER)} c/u</small></span>
            <div className="pos-qty">
              <button type="button" aria-label="Quitar una bolsa" disabled={!bagLine} onClick={() => bagLine && setQty(bagLine, bagLine.qty - 1)}>−</button>
              <output aria-label="Bolsas">{bagLine?.qty ?? 0}</output>
              <button type="button" aria-label="Agregar una bolsa" onClick={() => add(bagProduct)}>+</button>
            </div>
          </div>
        )}

        <dl className="pos-totals">
          <div><dt>Op. gravadas + exoneradas</dt><dd>{money(total - igv - icbper)}</dd></div>
          <div><dt>IGV (18%)</dt><dd>{money(igv)}</dd></div>
          {icbper > 0 && <div><dt>ICBPER ({bags} {bags === 1 ? "bolsa" : "bolsas"})</dt><dd>{money(icbper)}</dd></div>}
          {walletAmount > 0 && <div><dt>Pagado con monedero</dt><dd>− {money(walletAmount)}</dd></div>}
          <div className="grand"><dt>{walletAmount > 0 ? "A cobrar" : "Total"}</dt><dd>{money(toPay)}</dd></div>
        </dl>

        {error && <p className="pos-error" role="alert">{error}</p>}
        <button type="button" className="pos-pay" disabled={pending || cart.length === 0} onClick={checkout}>
          {pending ? "Emitiendo…" : `Cobrar ${money(toPay)}`}
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
            placeholder="Buscar por nombre, principio activo, acción terapéutica o código…" aria-label="Buscar producto o escanear código"
            enterKeyHint="search" autoComplete="off"
          />
          <button type="button" className="pos-cam" onClick={() => setScanning(true)} aria-label="Escanear con la cámara">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
              <path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2M7 8v8M10 8v8M13 8v8M16 8v8" />
            </svg>
            <span>Cámara</span>
          </button>
        </div>
        {cats.options.length > 0 && (
          <div className="pos-cats" role="group" aria-label="Filtrar por categoría">
            <button type="button" className={`pos-cat${activeCategory === null ? " on" : ""}`} aria-pressed={activeCategory === null} onClick={() => setCategory(null)}>Todas <span>{pool.length}</span></button>
            {cats.options.map((o) => (
              <button key={o.id} type="button" className={`pos-cat${activeCategory === o.id ? " on" : ""}`} aria-pressed={activeCategory === o.id} onClick={() => setCategory(o.id)}>{o.name} <span>{o.count}</span></button>
            ))}
            {cats.uncategorized > 0 && (
              <button type="button" className={`pos-cat${activeCategory === NO_CATEGORY ? " on" : ""}`} aria-pressed={activeCategory === NO_CATEGORY} onClick={() => setCategory(NO_CATEGORY)}>Sin categoría <span>{cats.uncategorized}</span></button>
            )}
          </div>
        )}
        <div className="pos-tools">
          <p className="pos-hint">{otcOnly ? "Venta rápida: solo productos de venta libre." : "Lector de códigos USB o Bluetooth: escanee directamente, sin hacer clic."}</p>
          <button type="button" className="app-btn" onClick={() => setClosing(true)}>Cierre de caja</button>
        </div>

        <div className="pos-grid">
          {results.length === 0 && <p className="pos-empty">{query ? `Sin resultados para «${query}»${activeCategory !== null ? " en esta categoría" : ""}.` : "No hay productos en esta categoría."}</p>}
          {results.map((p) => {
            const stock = available(p);
            const out = p.tracksBatches && !p.isService && stock <= 0;
            const expiredOnly = out && Number(p.expiredStock) > 0;
            const warn = out ? null : expiryWarning(p.nearestExpiry, today);
            return (
              <div key={p.id} className={`pos-card${out || (p.requiresRx && !canDispenseRx) ? " muted" : ""}`}>
                <button type="button" className="pos-card-main" onClick={() => add(p)} disabled={out}
                  aria-label={`Agregar ${p.name}, ${money(Number(p.salePrice))}`}>
                  <span className="pos-card-name">{p.name}</span>
                  {(p.dci || p.therapeuticAction) && (
                    <span className="pos-card-sub">{[p.dci && [p.dci, p.concentration].filter(Boolean).join(" "), p.therapeuticAction].filter(Boolean).join(" · ")}</span>
                  )}
                  <span className="pos-card-price">{money(Number(p.salePrice))}</span>
                  <span className="pos-card-meta">
                    {expiredOnly ? <span className="app-pill red">Lote vencido: no se vende</span> : out ? <span className="app-pill red">Agotado</span> : p.isService ? <span className="app-pill gray">Servicio</span>
                      : <span className={`app-pill ${stock < 10 ? "amber" : "green"}`}>Stock {stock}</span>}
                    {p.isControlled ? <span className="app-pill red">Controlado</span> : p.requiresRx && <span className="app-pill red">Receta</span>}
                    {!!p.withdrawalDays && <span className="app-pill red">Retiro {p.withdrawalDays} d</span>}
                    {warn && <span className="app-pill amber">{warn.label}</span>}
                  </span>
                </button>
                {!out && presentations(p).filter((u) => u !== "UNIT" && factor(p, u) <= stock).map((u) => (
                  <button key={u} type="button" className="pos-pack" onClick={() => add(p, u)}>
                    + {unitLabel(p, u)} · {money(unitPrice(p, u))}
                  </button>
                ))}
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

      {closing && <CashClosureModal branchId={branchId} onClose={() => setClosing(false)} />}

      {rxFor && (
        <div className="pos-overlay" role="dialog" aria-modal="true" aria-labelledby="rx-title">
          <div className="pos-modal">
            <h2 id="rx-title">{rxFor.product.isControlled ? "Producto controlado: datos del médico" : "Este producto requiere receta"}</h2>
            <p className="app-muted">{rxFor.product.name}{rxFor.product.isControlled ? " · psicotrópico o estupefaciente: se registra en el libro de controlados." : ""}</p>
            <PrescriptionForm
              branchId={branchId}
              kind={rxFor.product.rxKind ?? "SIMPLE"}
              patientDefault={custName}
              submitLabel="Validar y agregar a la venta"
              onCancel={() => setRxFor(null)}
              onSaved={(id) => { const { product, unit } = rxFor; setRxFor(null); add(product, unit, id); }}
            />
          </div>
        </div>
      )}

      {receipt && (
        <div className="pos-overlay" role="dialog" aria-modal="true" aria-labelledby="receipt-title">
          <div className="pos-receipt">
            <span className="pos-receipt-ok" aria-hidden>✓</span>
            <h2 id="receipt-title">Venta registrada</h2>
            <p className="pos-receipt-num">{receipt.number}</p>
            <p className="pos-receipt-total">S/ {receipt.total}</p>
            <p className="pos-receipt-note">Incluye IGV {money(Number(receipt.igv))}{Number(receipt.icbper) > 0 ? ` · ICBPER ${money(Number(receipt.icbper))}` : ""}</p>
            {receipt.change !== null && <p>Vuelto: <strong>{money(receipt.change)}</strong></p>}
            {receipt.wallet && (
              <p className="pos-receipt-note">
                {Number(receipt.wallet.redeemed) > 0 && <>Pagado con monedero: {money(Number(receipt.wallet.redeemed))}. </>}
                {Number(receipt.wallet.earned) > 0 && <>Ganó {money(Number(receipt.wallet.earned))}. </>}
                Saldo del monedero: <strong>{money(Number(receipt.wallet.balance))}</strong>
              </p>
            )}
            {receipt.warnings.map((w) => <p key={w} className="pos-warning">{w}</p>)}
            <p className="pos-receipt-note">El comprobante se envía a SUNAT automáticamente; su estado aparece en Comprobantes.</p>
            <button type="button" className="pos-pay" onClick={resetSale} autoFocus>Nueva venta</button>
          </div>
        </div>
      )}
    </div>
  );
}
