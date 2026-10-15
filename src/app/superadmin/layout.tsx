import type { ReactNode } from "react";
import { requirePlatformAdmin } from "@/lib/auth/session";

export default async function SuperadminLayout({ children }: { children: ReactNode }) {
  const admin = await requirePlatformAdmin();
  return (
    <>
      <header className="topbar">
        <nav aria-label="Plataforma">
          <strong>Nexo ERP · Plataforma</strong>
          <a href="/superadmin">Panel</a>
          <a href="/superadmin/tenants">Clientes</a>
        </nav>
        <span className="muted">{admin.email}</span>
      </header>
      {children}
    </>
  );
}
