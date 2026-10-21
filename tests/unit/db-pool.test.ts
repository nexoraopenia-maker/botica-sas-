import { describe, expect, it, vi } from "vitest";
import { describeDbError, serverlessConnectionString } from "@/lib/db";

describe("conexión a la base en serverless", () => {
  const session = "postgresql://postgres.abc:pw@aws-0-us-east-1.pooler.supabase.com:5432/postgres";

  it("cambia el pooler de Supabase de modo session (5432) a transaction (6543) solo en serverless", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(serverlessConnectionString(session, true)).toBe(session.replace(":5432/", ":6543/"));
    expect(serverlessConnectionString(session, false)).toBe(session);
  });

  it("no toca conexiones directas, locales ni ya en modo transaction", () => {
    for (const url of [
      "postgresql://postgres:pw@db.abc.supabase.co:5432/postgres",
      "postgresql://app_runtime:pw@127.0.0.1:5432/postgres",
      session.replace(":5432/", ":6543/"),
    ]) expect(serverlessConnectionString(url, true)).toBe(url);
  });

  it("extrae la causa real del error de Prisma", () => {
    const err = { code: "P2010", message: "Invalid `prisma.tenantUser.findFirst()` invocation", meta: { driverAdapterError: { cause: { originalCode: "XX000", originalMessage: "max clients reached", kind: "postgres" } } } };
    expect(describeDbError(err)).toMatchObject({ prismaCode: "P2010", pgCode: "XX000", detail: "max clients reached" });
  });
});
