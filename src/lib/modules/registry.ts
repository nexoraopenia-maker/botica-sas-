import type { ModuleKey } from "@/generated/prisma/enums";
import type { Permission } from "@/lib/auth/permissions";

export interface NavItem {
  href: string;
  label: string;
  module: ModuleKey;
  permission?: Permission;
}

/** Menú: se filtra por módulos activos del tenant y permisos del rol. */
export const NAV: readonly NavItem[] = [
  { href: "/app/pos", label: "Punto de venta", module: "CORE", permission: "pos.sell" },
  { href: "/app/documents", label: "Comprobantes", module: "CORE", permission: "documents.read" },
  { href: "/app/inventory", label: "Inventario", module: "CORE", permission: "inventory.read" },
  { href: "/app/inventory/expiry", label: "Caducidad", module: "CORE", permission: "inventory.read" },
  { href: "/app/purchases", label: "Compras", module: "CORE", permission: "purchases.manage" },
  { href: "/app/purchases/ai", label: "Cargar factura (IA)", module: "AI_INVENTORY", permission: "purchases.ai_ingest" },
  { href: "/app/customers", label: "Clientes", module: "CORE", permission: "customers.manage" },
  { href: "/app/vet/pets", label: "Pacientes", module: "VETERINARY", permission: "vet.records" },
  { href: "/app/vet/vaccines", label: "Vacunas por vencer", module: "VETERINARY", permission: "vet.vaccinate" },
  { href: "/app/agro/withdrawal", label: "Periodos de retiro", module: "AGRO", permission: "inventory.read" },
  { href: "/app/pharmacy/prescriptions", label: "Recetas", module: "PHARMACY", permission: "pharmacy.dispense_rx" },
  { href: "/app/pharmacy/controlled", label: "Libro de controlados", module: "PHARMACY", permission: "pharmacy.controlled_log" },
  { href: "/app/reports", label: "Reportes", module: "CORE", permission: "reports.read" },
  { href: "/app/settings", label: "Configuración", module: "CORE", permission: "settings.manage" },
];

/** Prefijos de ruta protegidos por módulo (lo usa requireModuleForPath y proxy.ts). */
export const ROUTE_MODULES: readonly { prefix: string; module: ModuleKey }[] = [
  { prefix: "/app/vet", module: "VETERINARY" },
  { prefix: "/app/agro", module: "AGRO" },
  { prefix: "/app/pharmacy", module: "PHARMACY" },
  { prefix: "/app/purchases/ai", module: "AI_INVENTORY" },
];

export function moduleForPath(pathname: string): ModuleKey | null {
  const hit = ROUTE_MODULES.find((r) => pathname === r.prefix || pathname.startsWith(`${r.prefix}/`));
  return hit?.module ?? null;
}

export function visibleNav(modules: ReadonlySet<ModuleKey>, can: (p: Permission) => boolean): NavItem[] {
  return NAV.filter((i) => modules.has(i.module) && (!i.permission || can(i.permission)));
}

/** Módulos que dependen de otros. */
export const MODULE_DEPENDENCIES: Partial<Record<ModuleKey, ModuleKey[]>> = {
  MAGISTRAL: ["PHARMACY"],
};
