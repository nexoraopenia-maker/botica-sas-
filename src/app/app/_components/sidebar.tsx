"use client";

import Link, { useLinkStatus } from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import type { NavItem } from "@/lib/modules/registry";
import { Icon } from "./icons";

/** Ruta activa: coincidencia exacta o el prefijo más largo (así /app/inventory/expiry no activa /app/inventory). */
function activeHref(pathname: string, items: NavItem[]): string | null {
  const matches = items.filter((i) => pathname === i.href || (i.href !== "/app" && pathname.startsWith(`${i.href}/`)));
  return matches.sort((a, b) => b.href.length - a.href.length)[0]?.href ?? null;
}

export function Sidebar({ items, tenantName }: { items: NavItem[]; tenantName: string }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  // Destino del último clic: se marca activo al instante, sin esperar la respuesta del servidor
  const [pendingHref, setPendingHref] = useState<string | null>(null);
  useEffect(() => {
    setOpen(false); // cerrar en móvil al navegar
    setPendingHref(null);
  }, [pathname]);

  const active = pendingHref ?? activeHref(pathname, items);
  const groups = [...new Set(items.map((i) => i.group))];

  return (
    <>
      <button type="button" className="app-menu-btn" aria-label="Abrir menú" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <Icon name="menu" size={20} />
      </button>
      {pendingHref && <div className="app-progress" aria-hidden />}
      {open && <div className="app-scrim" onClick={() => setOpen(false)} aria-hidden />}
      <aside className={`app-sidebar${open ? " open" : ""}`} aria-label="Menú principal">
        <div className="app-brand">
          <Image src="/brand/aima-logo.png" alt="AIMA" width={1197} height={361} className="app-brand-logo" priority />
          <span className="app-brand-tenant" title={tenantName}>{tenantName}</span>
        </div>
        <nav className="app-nav">
          {groups.map((g) => (
            <div key={g} className="app-nav-group">
              <p className="app-nav-title">{g}</p>
              {items.filter((i) => i.group === g).map((i) => (
                <Link key={i.href} href={i.href} className={`app-nav-link${active === i.href ? " active" : ""}`}
                  aria-current={active === i.href ? "page" : undefined}
                  onClick={(e) => {
                    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; // nueva pestaña: sin cambio
                    if (i.href !== pathname) setPendingHref(i.href);
                  }}>
                  <Icon name={i.icon} />
                  <span>{i.label}</span>
                  <PendingDot />
                </Link>
              ))}
            </div>
          ))}
        </nav>
      </aside>
    </>
  );
}

/** Indicador dentro del enlace mientras su navegación está en curso (useLinkStatus de Next). */
function PendingDot() {
  const { pending } = useLinkStatus();
  return pending ? <span className="app-nav-pending" aria-hidden /> : null;
}
