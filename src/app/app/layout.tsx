import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { Inter } from "next/font/google";
import { getIdentity, getTenantContext } from "@/lib/auth/session";
import { hasPermission, SYSTEM_ROLES } from "@/lib/auth/permissions";
import { visibleNav } from "@/lib/modules/registry";
import { platformDb } from "@/lib/db";
import { signOutAction } from "@/app/login/actions";
import { exitSupportAction } from "@/app/superadmin/actions";
import { Sidebar } from "./_components/sidebar";
import { Icon } from "./_components/icons";
import { ChangePasswordButton } from "@/app/account/change-password";
import { InstallAppButton } from "@/app/account/install-app";

const inter = Inter({ subsets: ["latin"], display: "swap" });

export default async function TenantLayout({ children }: { children: ReactNode }) {
  const ctx = await getTenantContext();
  if (!ctx) {
    // Un administrador de plataforma sin negocio propio va a su panel, no a un error
    const identity = await getIdentity();
    const isAdmin = identity && (await platformDb().platformAdmin.findFirst({ where: { id: identity.userId, deleted_at: null } }));
    redirect(isAdmin ? "/superadmin" : "/login?error=no_tenant");
  }

  const db = platformDb();
  const [tenant, user, unread] = await Promise.all([
    db.tenant.findUniqueOrThrow({ where: { id: ctx.tenantId }, select: { legal_name: true, trade_name: true, sunat_env: true } }),
    db.user.findUnique({ where: { id: ctx.userId }, select: { full_name: true, email: true } }),
    db.notification.count({ where: { tenant_id: ctx.tenantId, user_id: ctx.userId, channel: "IN_APP", read_at: null } }),
  ]);
  const tenantName = tenant.trade_name ?? tenant.legal_name;
  const displayName = user?.full_name ?? (ctx.impersonation ? "Soporte de plataforma" : "Usuario");
  const roleName = ctx.impersonation ? "Soporte" : (SYSTEM_ROLES[ctx.roleKey]?.name ?? ctx.roleKey);
  const initials = displayName.split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? "").join("");
  const nav = visibleNav(ctx.modules, (p) => hasPermission(ctx.permissions, p));

  return (
    <div className={`app-shell ${inter.className}`}>
      <Sidebar items={nav} tenantName={tenantName} />
      <div className="app-main">
        {ctx.impersonation && (
          <div className="app-banner" role="status">
            <Icon name="alert" size={16} />
            Sesión de soporte {ctx.impersonation.readOnly ? "(solo lectura)" : "(con escritura)"} · expira a las{" "}
            {ctx.impersonation.expiresAt.toLocaleTimeString("es-PE", { timeZone: "America/Lima", hour: "2-digit", minute: "2-digit" })}
            {" "}· todas las acciones se auditan
            <form action={exitSupportAction} className="app-banner-exit">
              <button type="submit">Salir del modo soporte</button>
            </form>
          </div>
        )}
        <header className="app-topbar">
          <div className="app-topbar-title">
            <strong>{tenantName}</strong>
            {tenant.sunat_env === "BETA" && <span className="app-pill amber" title="Los comprobantes se envían al ambiente de pruebas de SUNAT">SUNAT beta</span>}
          </div>
          <div className="app-topbar-right">
            <span className="app-bell" title={`${unread} notificaciones sin leer`}>
              <Icon name="bell" size={19} />
              {unread > 0 && <span className="app-bell-dot">{unread > 9 ? "9+" : unread}</span>}
            </span>
            <details className="app-user">
              <summary>
                <span className="app-avatar" aria-hidden>{initials || "U"}</span>
                <span className="app-user-text">
                  <span className="app-user-name">{displayName}</span>
                  <span className="app-user-role">{roleName}</span>
                </span>
              </summary>
              <div className="app-user-menu">
                <p className="app-user-email">{user?.email}</p>
                {!ctx.impersonation && <ChangePasswordButton />}
                <InstallAppButton />
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
