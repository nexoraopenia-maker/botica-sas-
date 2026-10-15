import { z } from "zod";

/**
 * Esquema que el modelo debe devolver (structured outputs) y que se vuelve
 * a validar en el servidor. Los importes llegan como string decimal para no
 * perder precisión en JSON.
 */
const decimalString = z.string().regex(/^-?\d+(\.\d+)?$/, "decimal como string, punto como separador");
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");

export const extractedItemSchema = z.object({
  line_no: z.number().int().min(1),
  supplier_code: z.string().nullable().describe("Código del producto en la factura del proveedor, si aparece"),
  description: z.string().min(1).describe("Descripción tal cual aparece, incluyendo presentación"),
  quantity: decimalString,
  unit: z.string().nullable().describe("Unidad tal cual aparece: UND, CJA, KG, FCO, NIU, BX…"),
  units_per_package: z.number().int().nullable().describe("Si la descripción indica 'x100', 'caja x 20', etc."),
  unit_price: decimalString.describe("Precio unitario"),
  unit_price_includes_igv: z.boolean(),
  line_total: decimalString.nullable(),
  igv_affectation: z.enum(["GRAVADO", "EXONERADO", "INAFECTO", "DESCONOCIDO"]),
  lot_code: z.string().nullable().describe("Lote/Lot/L: si aparece en la línea"),
  expiry_date: isoDate.nullable().describe("Vencimiento/Exp/F.V. en formato YYYY-MM-DD; si solo hay mes/año usar último día del mes"),
  registration_code: z.string().nullable().describe("Registro sanitario DIGEMID o SENASA si aparece"),
  confidence: z.number().min(0).max(1).describe("Confianza de lectura de ESTA línea"),
});

export const extractedInvoiceSchema = z.object({
  is_purchase_document: z.boolean().describe("false si la imagen no es un comprobante de compra"),
  document_type: z.enum(["FACTURA", "BOLETA", "GUIA_REMISION", "NOTA_CREDITO", "PROFORMA", "OTRO"]),
  supplier: z.object({
    ruc: z.string().nullable(),
    legal_name: z.string().nullable(),
    address: z.string().nullable(),
  }),
  buyer_ruc: z.string().nullable().describe("RUC del adquirente, para verificar que la factura es del negocio"),
  series: z.string().nullable(),
  number: z.string().nullable(),
  issue_date: isoDate.nullable(),
  currency: z.enum(["PEN", "USD"]),
  subtotal: decimalString.nullable(),
  igv: decimalString.nullable(),
  total: decimalString.nullable(),
  items: z.array(extractedItemSchema),
  overall_confidence: z.number().min(0).max(1),
  warnings: z.array(z.string()).describe("Partes ilegibles, cortadas, tachadas o ambiguas"),
});

export type ExtractedInvoice = z.infer<typeof extractedInvoiceSchema>;
export type ExtractedItem = z.infer<typeof extractedItemSchema>;
