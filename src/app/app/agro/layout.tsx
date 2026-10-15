import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { getTenantContext } from "@/lib/auth/session";

/** Guard de módulo: si AGRO no está activo para el tenant, la ruta no existe. */
export default async function ModuleLayout({ children }: { children: ReactNode }) {
  const ctx = await getTenantContext();
  if (!ctx?.modules.has("AGRO")) notFound();
  return <>{children}</>;
}
