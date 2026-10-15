import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { getTenantContext } from "@/lib/auth/session";
import { hasPermission } from "@/lib/auth/permissions";
import { visibleNav } from "@/lib/modules/registry";

export default async function TenantLayout({ children }: { children: ReactNode }) {
  const ctx = await getTenantContext();
  if (!ctx) redirect("/login?error=no_tenant");
  const nav = visibleNav(ctx.modules, (p) => hasPermission(ctx.permissions, p));

  return (
    <>
      {ctx.impersonation && (
        <div className="banner" role="status">
          Sesión de soporte {ctx.impersonation.readOnly ? "(solo lectura)" : "(con escritura)"} — expira{" "}
          {ctx.impersonation.expiresAt.toLocaleTimeString("es-PE", { timeZone: "America/Lima" })}. Todas las acciones se auditan.
        </div>
      )}
      <div className="shell">
        <nav className="side" aria-label="Menú principal">
          {nav.map((i) => (
            <a key={i.href} href={i.href}>{i.label}</a>
          ))}
        </nav>
        <main>{children}</main>
      </div>
    </>
  );
}
