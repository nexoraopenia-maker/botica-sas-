import type { SaleUnit } from "@/generated/prisma/enums";
import { D, type Decimal, type DecimalInput } from "@/lib/money";
import { DomainError } from "@/lib/result";

export interface FractionableProduct {
  name: string;
  unit_code: string;
  sale_price: Decimal;
  package_price: Decimal | null;
  units_per_package: number;
  units_per_blister?: number;
  blister_price?: Decimal | null;
  package_unit_code: string | null;
  allow_fractional: boolean;
}

export interface SaleUnitResolution {
  baseQuantity: Decimal; // unidad base (kardex)
  unitPrice: Decimal;    // precio por unidad de venta, IGV incluido
  unitCode: string;      // catálogo 03 de la unidad de venta
}

/**
 * Conversión unidad de venta → unidad base. Ej.: caja x100 tabletas.
 *  - UNIT    : qty tabletas, precio unitario
 *  - BLISTER : qty blísteres → qty×tabletas por blíster, precio de blíster (o proporcional)
 *  - PACKAGE : qty cajas → qty×100 tabletas, precio de caja (o 100×unitario si no hay precio de caja)
 * El kardex siempre descuenta en unidad base.
 */
export function resolveSaleUnit(p: FractionableProduct, saleUnit: SaleUnit, quantity: DecimalInput): SaleUnitResolution {
  const qty = D(quantity);
  if (qty.lte(0)) throw new DomainError("INVALID_QTY", `Cantidad inválida para ${p.name}`);

  if (saleUnit === "PACKAGE") {
    if (p.units_per_package <= 1) throw new DomainError("NO_PACKAGE", `${p.name} no se vende por empaque`);
    if (!qty.isInteger()) throw new DomainError("INVALID_QTY", `La venta por empaque de ${p.name} debe ser entera`);
    return {
      baseQuantity: qty.times(p.units_per_package),
      unitPrice: p.package_price ?? p.sale_price.times(p.units_per_package),
      unitCode: p.package_unit_code ?? "BX",
    };
  }
  if (saleUnit === "BLISTER") {
    const per = p.units_per_blister ?? 1;
    if (per <= 1) throw new DomainError("NO_BLISTER", `${p.name} no se vende por blíster`);
    if (!qty.isInteger()) throw new DomainError("INVALID_QTY", `La venta por blíster de ${p.name} debe ser entera`);
    return { baseQuantity: qty.times(per), unitPrice: p.blister_price ?? p.sale_price.times(per), unitCode: "NIU" };
  }
  if (!p.allow_fractional && !qty.isInteger()) {
    throw new DomainError("INVALID_QTY", `${p.name} no admite cantidades fraccionadas`);
  }
  return { baseQuantity: qty, unitPrice: p.sale_price, unitCode: p.unit_code };
}

/** Presenta stock en unidades base como "3 cajas + 2 blíst. + 5 unid." */
export function formatStock(base: Decimal, unitsPerPackage: number, unitsPerBlister = 1): string {
  if (unitsPerPackage <= 1 && unitsPerBlister <= 1) return base.toString();
  const parts: string[] = [];
  let rest = base;
  if (unitsPerPackage > 1) {
    const packs = rest.div(unitsPerPackage).floor();
    parts.push(`${packs.toString()} emp.`);
    rest = rest.minus(packs.times(unitsPerPackage));
  }
  if (unitsPerBlister > 1 && unitsPerBlister < Math.max(unitsPerPackage, unitsPerBlister + 1)) {
    const blisters = rest.div(unitsPerBlister).floor();
    parts.push(`${blisters.toString()} blíst.`);
    rest = rest.minus(blisters.times(unitsPerBlister));
  }
  parts.push(`${rest.toString()} unid.`);
  return parts.join(" + ");
}
