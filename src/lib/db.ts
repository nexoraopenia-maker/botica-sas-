import "server-only";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, Prisma } from "@/generated/prisma/client";
import { env } from "@/lib/env";

export { Prisma };
export type Tx = Prisma.TransactionClient;

/**
 * Dos clientes con privilegios distintos:
 *  • runtimeDb  → rol app_runtime (NOBYPASSRLS). TODO acceso de tenant pasa por withTenant().
 *  • platformDb → rol propietario (BYPASSRLS). Solo superadmin, workers y jobs.
 *    Nunca se importa desde código que maneje input de un tenant sin pasar por guards de plataforma.
 */
const globalForPrisma = globalThis as unknown as {
  runtimeDb?: PrismaClient;
  platformDb?: PrismaClient;
};

/** Vercel/Netlify/Lambda: muchas instancias efímeras, cada una con su propio pool. */
const SERVERLESS = !!(process.env.VERCEL || process.env.NETLIFY || process.env.AWS_LAMBDA_FUNCTION_NAME);

/**
 * En serverless, el pooler de Supabase en modo *session* (puerto 5432) admite pocos clientes en total y
 * se agota con varias instancias ("max clients reached"), lo que aparece como PrismaClientKnownRequestError
 * en la primera consulta de cada página. El modo *transaction* (6543) es el indicado: se usa automáticamente.
 * Las migraciones usan DIRECT_URL y no pasan por aquí.
 */
export function serverlessConnectionString(url: string, serverless = SERVERLESS): string {
  if (!serverless) return url;
  try {
    const u = new URL(url);
    if (u.hostname.endsWith(".pooler.supabase.com") && u.port === "5432") {
      u.port = "6543";
      console.warn(`[db] ${u.username.split(".")[0]}: pooler en modo session (5432) en serverless → usando modo transaction (6543). Actualice la variable de entorno.`);
      return u.toString();
    }
  } catch { /* URL no estándar: se usa tal cual */ }
  return url;
}

function makeClient(connectionString: string): PrismaClient {
  return new PrismaClient({
    adapter: new PrismaPg({
      connectionString: serverlessConnectionString(connectionString),
      // Pocas conexiones por instancia en serverless (se multiplican por instancias) y liberación rápida
      max: SERVERLESS ? 2 : 10,
      idleTimeoutMillis: SERVERLESS ? 5_000 : 30_000,
      connectionTimeoutMillis: 10_000,
    }),
    log: env().NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });
}

/** Extrae el error real de PostgreSQL que Prisma envuelve en "Invalid `prisma.x()` invocation". */
export function describeDbError(err: unknown): Record<string, unknown> {
  const e = err as { code?: string; message?: string; meta?: { driverAdapterError?: { cause?: { originalCode?: string; originalMessage?: string; kind?: string; message?: string } } } };
  const cause = e?.meta?.driverAdapterError?.cause;
  return {
    prismaCode: e?.code,
    pgCode: cause?.originalCode,
    kind: cause?.kind,
    detail: (cause?.originalMessage ?? cause?.message ?? e?.message ?? String(err)).slice(0, 400),
  };
}

export function runtimeDb(): PrismaClient {
  globalForPrisma.runtimeDb ??= makeClient(env().DATABASE_URL);
  return globalForPrisma.runtimeDb;
}

export function platformDb(): PrismaClient {
  globalForPrisma.platformDb ??= makeClient(env().PLATFORM_DATABASE_URL);
  return globalForPrisma.platformDb;
}

export interface TenantDbContext {
  tenantId: string;
  userId: string;
}

export interface WithTenantOptions {
  isolationLevel?: Prisma.TransactionIsolationLevel;
  timeoutMs?: number;
}

/**
 * Ejecuta `fn` en una transacción con el contexto de tenant fijado vía GUC
 * local a la transacción (`set_config(..., true)`), que es lo que leen las
 * políticas RLS. Seguro con PgBouncer en modo transaction.
 */
export async function withTenant<T>(
  ctx: TenantDbContext,
  fn: (tx: Tx) => Promise<T>,
  opts: WithTenantOptions = {},
): Promise<T> {
  return runtimeDb().$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${ctx.tenantId}, true),
                                  set_config('app.user_id', ${ctx.userId}, true)`;
      return fn(tx);
    },
    {
      isolationLevel: opts.isolationLevel ?? Prisma.TransactionIsolationLevel.ReadCommitted,
      timeout: opts.timeoutMs ?? 15_000,
      maxWait: 5_000,
    },
  );
}

/** Igual que withTenant pero con el cliente de plataforma (workers que actúan "en nombre de" un tenant). */
export async function withTenantAsSystem<T>(tenantId: string, fn: (tx: Tx) => Promise<T>, timeoutMs = 60_000): Promise<T> {
  return platformDb().$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      return fn(tx);
    },
    { timeout: timeoutMs, maxWait: 5_000 },
  );
}
