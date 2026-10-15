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

function makeClient(connectionString: string): PrismaClient {
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString, max: 10 }),
    log: env().NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });
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
