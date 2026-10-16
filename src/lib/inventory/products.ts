import "server-only";
import { z } from "zod";
import { Prisma, withTenant, type TenantDbContext } from "@/lib/db";
import { audit } from "@/lib/audit";
import { D } from "@/lib/money";
import { DomainError } from "@/lib/result";
import { limaNow } from "@/lib/time";
import { looksLikeBrokenGtin, normalizeCode } from "@/lib/inventory/barcode";

const dec = (min = 0) => z.union([z.number(), z.string()]).transform((v) => D(String(v).replace(",", "."))).refine((d) => d.gte(min), `Debe ser ≥ ${min}`);
const optStr = (max: number) => z.string().trim().max(max).optional().transform((v) => (v ? v : undefined));

export const createProductSchema = z.object({
  name: z.string().trim().min(2, "Nombre del producto (mínimo 2 caracteres)").max(160),
  sku: z.string().trim().toUpperCase().regex(/^[A-Z0-9._-]{2,40}$/, "SKU: 2 a 40 letras, números, punto, guion o guion bajo"),
  barcode: z.string().optional().transform((v) => (v ? normalizeCode(v) : undefined))
    .refine((v) => !v || /^[A-Za-z0-9-]{4,48}$/.test(v), "Código de barras inválido"),
  categoryId: z.uuid().optional(),
  newCategory: optStr(80),
  salePrice: dec(0),
  unitCode: z.enum(["NIU", "ZZ", "KGM", "GRM", "LTR", "MLT", "BX", "BG", "BO", "SA", "TAB", "AM", "VI"]).default("NIU"),
  igvAffectation: z.enum(["10", "20", "30"]).default("10"),
  minStock: dec(0).optional().transform((v) => v ?? D(0)),
  allowFractional: z.boolean().default(false),
  isService: z.boolean().default(false),
  unitsPerPackage: z.number().int().min(1).max(10000).default(1),
  packagePrice: dec(0).optional(),
  // Agro / Veterinaria
  senasaRegistration: optStr(60),
  withdrawalDaysMeat: z.number().int().min(0).max(365).optional(),
  withdrawalDaysMilk: z.number().int().min(0).max(365).optional(),
  // Farmacia
  dci: optStr(120),
  concentration: optStr(60),
  pharmaceuticalForm: optStr(60),
  laboratory: optStr(120),
  digemidRegistration: optStr(60),
  pharmaceuticalKind: z.enum(["GENERIC", "BRAND"]).optional(),
  saleCondition: z.enum(["FREE", "PRESCRIPTION", "RETAINED_PRESCRIPTION"]).optional(),
  isControlled: z.boolean().default(false),
  // Stock inicial (opcional)
  initialStock: z.object({
    branchId: z.uuid(),
    quantity: dec(0).refine((d) => d.gt(0), "Cantidad mayor a 0"),
    unitCost: dec(0),
    lotCode: optStr(40),
    expiryDate: z.iso.date().optional(),
  }).optional(),
}).refine((v) => !v.isControlled || v.saleCondition === "RETAINED_PRESCRIPTION", {
  message: "Un producto controlado requiere receta retenida", path: ["saleCondition"],
}).refine((v) => v.unitsPerPackage === 1 || !!v.packagePrice, {
  message: "Indique el precio por empaque", path: ["packagePrice"],
});

export interface CreateProductCaps {
  canAdjustStock: boolean;
  modules: ReadonlySet<string>;
}

export interface CreateProductResult {
  productId: string;
  sku: string;
  warnings: string[];
}

export async function createProduct(ctx: TenantDbContext, raw: z.input<typeof createProductSchema>, caps: CreateProductCaps): Promise<CreateProductResult> {
  const i = createProductSchema.parse(raw);
  const pharmacy = caps.modules.has("PHARMACY");
  const agro = caps.modules.has("AGRO") || caps.modules.has("VETERINARY");
  if (i.initialStock && !caps.canAdjustStock) throw new DomainError("FORBIDDEN", "No tiene permiso para registrar stock inicial.");
  if (i.initialStock && i.isService) throw new DomainError("VALIDATION", "Un servicio no lleva stock.");
  const warnings: string[] = [];
  if (i.barcode && looksLikeBrokenGtin(i.barcode)) warnings.push("El código de barras no supera el dígito verificador EAN/UPC: verifique que se leyó bien.");

  try {
    return await withTenant(ctx, async (tx) => {
      let categoryId = i.categoryId ?? null;
      if (!categoryId && i.newCategory) {
        const cat = await tx.productCategory.upsert({
          where: { tenant_id_name: { tenant_id: ctx.tenantId, name: i.newCategory } },
          create: { tenant_id: ctx.tenantId, name: i.newCategory },
          update: { deleted_at: null },
        });
        categoryId = cat.id;
      } else if (categoryId && !(await tx.productCategory.findFirst({ where: { id: categoryId } }))) {
        throw new DomainError("VALIDATION", "Categoría inválida.");
      }

      const p = await tx.product.create({
        data: {
          tenant_id: ctx.tenantId, category_id: categoryId, sku: i.sku, barcode: i.barcode ?? null, name: i.name,
          unit_code: i.isService ? "ZZ" : i.unitCode, igv_affectation: i.igvAffectation, sale_price: i.salePrice,
          package_price: i.unitsPerPackage > 1 ? (i.packagePrice ?? null) : null, units_per_package: i.unitsPerPackage,
          package_unit_code: i.unitsPerPackage > 1 ? "BX" : null, allow_fractional: i.allowFractional, min_stock: i.minStock,
          is_service: i.isService, tracks_batches: !i.isService,
          senasa_registration: agro ? (i.senasaRegistration ?? null) : null,
          withdrawal_days_meat: agro ? (i.withdrawalDaysMeat ?? null) : null,
          withdrawal_days_milk: agro ? (i.withdrawalDaysMilk ?? null) : null,
          dci: pharmacy ? (i.dci ?? null) : null, concentration: pharmacy ? (i.concentration ?? null) : null,
          pharmaceutical_form: pharmacy ? (i.pharmaceuticalForm ?? null) : null, laboratory: pharmacy ? (i.laboratory ?? null) : null,
          digemid_registration: pharmacy ? (i.digemidRegistration ?? null) : null,
          pharmaceutical_kind: pharmacy ? (i.pharmaceuticalKind ?? null) : null,
          sale_condition: pharmacy ? (i.saleCondition ?? "FREE") : null, is_controlled: pharmacy && i.isControlled,
        },
      });

      if (i.initialStock) {
        const s = i.initialStock;
        const branch = await tx.branch.findFirst({ where: { id: s.branchId, is_active: true, deleted_at: null } });
        if (!branch) throw new DomainError("VALIDATION", "Sucursal inválida.");
        const lot = s.lotCode ?? `INICIAL-${limaNow().date.replaceAll("-", "")}`;
        const batch = await tx.productBatch.create({
          data: {
            tenant_id: ctx.tenantId, branch_id: branch.id, product_id: p.id, lot_code: lot,
            expiry_date: s.expiryDate ? new Date(`${s.expiryDate}T00:00:00Z`) : null, unit_cost: s.unitCost, stock: s.quantity,
          },
        });
        // Kardex: ajuste de entrada (inventario inicial), no una compra
        await tx.stockMovement.create({
          data: {
            tenant_id: ctx.tenantId, branch_id: branch.id, product_id: p.id, batch_id: batch.id, type: "ADJUSTMENT_IN",
            quantity: s.quantity, balance_after: s.quantity, unit_cost: s.unitCost, ref_type: "initial_stock", ref_id: p.id,
            note: "Stock inicial al crear el producto", created_by: ctx.userId,
          },
        });
        if (p.is_controlled) {
          await tx.controlledSubstanceLog.create({
            data: { tenant_id: ctx.tenantId, branch_id: branch.id, product_id: p.id, batch_id: batch.id, movement: "IN", quantity: s.quantity, balance: 0, counterparty: "Inventario inicial", recorded_by: ctx.userId },
          });
        }
      }

      await audit(tx, {
        tenantId: ctx.tenantId, actorUserId: ctx.userId, actorKind: "tenant_user", action: "product.create", entityType: "product", entityId: p.id,
        after: { sku: p.sku, barcode: p.barcode, name: p.name, price: p.sale_price.toString(), initialStock: i.initialStock?.quantity.toString() ?? null },
      });
      return { productId: p.id, sku: p.sku, warnings };
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const target = JSON.stringify(err.meta ?? {});
      throw new DomainError("DUPLICATE", target.includes("barcode")
        ? "Ya existe un producto con ese código de barras."
        : target.includes("sku") ? `Ya existe un producto con el SKU ${i.sku}.` : "El producto ya existe (SKU o código de barras repetido).");
    }
    throw err;
  }
}
