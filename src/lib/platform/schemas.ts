import { z } from "zod";
import { isValidRuc } from "@/lib/sunat/validation";

export const MODULE_KEYS = ["CORE", "VETERINARY", "AGRO", "PHARMACY", "MAGISTRAL", "AI_INVENTORY", "WHATSAPP", "DISPATCH_GUIDES"] as const;
export const BUSINESS_LINES = ["AGROVET", "VETERINARY", "PHARMACY", "RETAIL"] as const;

const ruc = z.string().trim().refine(isValidRuc, "RUC inválido (dígito verificador)");
const ubigeo = z.string().regex(/^\d{6}$/, "Ubigeo de 6 dígitos");

export const tenantFiscalSchema = z.object({
  ruc,
  legalName: z.string().trim().min(3).max(200),
  tradeName: z.string().trim().max(200).optional(),
  fiscalAddress: z.string().trim().min(5).max(250),
  ubigeo,
  department: z.string().trim().min(2),
  province: z.string().trim().min(2),
  district: z.string().trim().min(2),
  urbanization: z.string().trim().max(100).optional(),
});

export const createTenantSchema = tenantFiscalSchema.extend({
  slug: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/, "Solo minúsculas, números y guiones"),
  businessLines: z.array(z.enum(BUSINESS_LINES)).min(1),
  planId: z.uuid(),
  contactName: z.string().trim().min(3),
  contactEmail: z.email(),
  contactPhone: z.string().trim().max(20).optional(),
  adminEmail: z.email(),
  adminFullName: z.string().trim().min(3),
  oseProvider: z.enum(["SUNAT_SEE", "OSE_GENERIC"]).default("SUNAT_SEE"),
  oseEndpoint: z.url().optional(),
  /** Selección explícita desde el panel; si se omite, se derivan de rubros + plan */
  modules: z.array(z.enum(MODULE_KEYS)).optional(),
});
export type CreateTenantInput = z.input<typeof createTenantSchema>;

export const updateTenantSchema = tenantFiscalSchema.partial().extend({
  tenantId: z.uuid(),
  businessLines: z.array(z.enum(BUSINESS_LINES)).min(1).optional(),
  contactName: z.string().trim().min(3).optional(),
  contactEmail: z.email().optional(),
  contactPhone: z.string().trim().max(20).optional(),
  logoPath: z.string().optional(),
  oseProvider: z.enum(["SUNAT_SEE", "OSE_GENERIC"]).optional(),
  oseEndpoint: z.url().nullable().optional(),
  sunatEnv: z.enum(["BETA", "PRODUCTION"]).optional(),
});

export const setModulesSchema = z.object({
  tenantId: z.uuid(),
  modules: z.array(z.enum(MODULE_KEYS)),
});

export const reasonSchema = z.string().trim().min(15, "Explique el motivo (mínimo 15 caracteres)").max(500);

export const suspendSchema = z.object({ tenantId: z.uuid(), reason: reasonSchema });
export const deletionSchema = z.object({ tenantId: z.uuid(), reason: reasonSchema, graceDays: z.number().int().min(7).max(90).default(30) });
export const purgeSchema = z.object({
  tenantId: z.uuid(),
  confirmRuc: ruc,
  confirmPhrase: z.string(),
});

export const solSchema = z.object({ tenantId: z.uuid(), solUser: z.string().trim().min(3).max(20), solPassword: z.string().min(1).max(100) });

export const certificateSchema = z.object({
  tenantId: z.uuid(),
  pfx: z.instanceof(File).refine((f) => f.size > 0 && f.size < 50_000, "Archivo .pfx inválido"),
  password: z.string().max(200),
});

export const impersonationSchema = z.object({
  tenantId: z.uuid(),
  reason: reasonSchema,
  ticketRef: z.string().max(50).optional(),
  readOnly: z.boolean().default(true),
  minutes: z.number().int().min(5).max(60).default(30),
});

export const branchSchema = z.object({
  tenantId: z.uuid(),
  sunatCode: z.string().regex(/^\d{4}$/),
  name: z.string().trim().min(2),
  address: z.string().trim().min(5),
  ubigeo,
  series: z.array(z.object({ docType: z.enum(["FACTURA", "BOLETA", "NOTA_CREDITO", "NOTA_DEBITO"]), series: z.string().regex(/^[FB][A-Z0-9]{3}$/) })).default([]),
});
