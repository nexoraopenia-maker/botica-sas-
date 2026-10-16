import type { ReactNode } from "react";
import { Inter } from "next/font/google";
import { requirePlatformAdmin } from "@/lib/auth/session";
import { signOutAction } from "@/app/login/actions";
import { Sidebar, type SidebarItem } from "@/app/app/_components/sidebar";
import { Icon } from "@/app/app/_components/icons";

const inter = Inter({ subsets: ["latin"], display: "swap" });

const NAV: SidebarItem[] = [
  { href: "/superadmin", label: "Panel", group: "Plataforma", icon: "home" },
  { href: "/superadmin/tenants", label: "Clientes", group: "Plataforma", icon: "building" },
  { href: "/superadmin/tenants/new", label: "Nuevo cliente", group: "Plataforma", icon: "plus" },
];

const ROLE: Record<string, string> = { OWNER: "Propietario", SUPPORT: "Soporte", BILLING: "Facturación" };

export default async function SuperadminLayout({ children }: { children: ReactNode }) {
  const admin = await requirePlatformAdmin();
  const initials = admin.email.slice(0, 2).toUpperCase();
  return (
    <div className={`app-shell ${inter.className}`}>
      <Sidebar items={NAV} tenantName="Panel de plataforma" root="/superadmin" />
      <div className="app-main">
        <header className="app-topbar">
          <div className="app-topbar-title">
            <strong>Nexo ERP · Plataforma</strong>
            <span className="app-pill blue" title="Acceso protegido con verificación en dos pasos"><Icon name="shield" size={13} />&nbsp;MFA</span>
          </div>
          <div className="app-topbar-right">
            <details className="app-user">
              <summary>
                <span className="app-avatar" aria-hidden>{initials}</span>
                <span className="app-user-text">
                  <span className="app-user-name">{admin.email}</span>
                  <span className="app-user-role">{ROLE[admin.role] ?? admin.role}</span>
                </span>
              </summary>
              <div className="app-user-menu">
                <p className="app-user-email">{admin.email}</p>
                <form action={signOutAction}>
                  <button type="submit" className="app-user-item"><Icon name="logout" size={16} /> Cerrar sesión</button>
                </form>
              </div>
            </details>
          </div>
        </header>
        <main className="app-content">{children}</main>
      </div>
    </div>
  );
}
