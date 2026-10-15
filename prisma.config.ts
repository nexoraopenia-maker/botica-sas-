import { defineConfig } from "prisma/config";

// Prisma CLI usa DIRECT_URL (sin pooler) para migraciones.
// La app en runtime usa DATABASE_URL vía @prisma/adapter-pg (ver src/lib/db.ts).
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: { url: process.env["DIRECT_URL"] ?? process.env["DATABASE_URL"] ?? "" },
});
