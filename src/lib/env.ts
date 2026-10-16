import "server-only";
import { z } from "zod";
import { hasWrappingQuotes } from "@/lib/auth/login-errors";

const serverSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  NEXT_PUBLIC_APP_URL: z.url(),
  DATABASE_URL: z.string().min(1),
  PLATFORM_DATABASE_URL: z.string().min(1),
  NEXT_PUBLIC_SUPABASE_URL: z.url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  SECRETS_KEK_BASE64: z
    .string()
    .refine((v) => Buffer.from(v, "base64").length === 32, "KEK debe ser 32 bytes en base64"),
  SECRETS_KEK_ID: z.string().default("local-v1"),
  SUNAT_ENV: z.enum(["beta", "production"]).default("beta"),
  SUNAT_BETA_URL: z.url(),
  SUNAT_PROD_URL: z.url(),
  RUC_LOOKUP_URL: z.string().optional(),
  RUC_LOOKUP_TOKEN: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  VOYAGE_API_KEY: z.string().optional(),
  WHATSAPP_PROVIDER: z.enum(["meta", "twilio"]).default("meta"),
  META_WA_PHONE_NUMBER_ID: z.string().optional(),
  META_WA_ACCESS_TOKEN: z.string().optional(),
  META_WA_APP_SECRET: z.string().optional(),
  META_WA_VERIFY_TOKEN: z.string().optional(),
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_WHATSAPP_FROM: z.string().optional(),
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().default("Nexo ERP <no-reply@example.pe>"),
  INTERNAL_CRON_SECRET: z.string().min(32),
});

export type ServerEnv = z.infer<typeof serverSchema>;

let cached: ServerEnv | undefined;

/** Valida variables de entorno de forma perezosa (falla rápido en el primer uso). */
export function env(): ServerEnv {
  if (!cached) {
    // Error típico al pegar en el panel del hosting: el valor queda con comillas literales
    const quoted = Object.keys(serverSchema.shape).filter((k) => hasWrappingQuotes(process.env[k]));
    if (quoted.length) {
      throw new Error(`Variables de entorno con comillas alrededor del valor (quítelas en el panel del hosting): ${quoted.join(", ")}`);
    }
    const parsed = serverSchema.safeParse(process.env);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      throw new Error(`Variables de entorno inválidas: ${issues}`);
    }
    cached = parsed.data;
  }
  return cached;
}
