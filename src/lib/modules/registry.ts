import type { BusinessLine, ModuleKey } from "@/generated/prisma/enums";
import type { Permission } from "@/lib/auth/permissions";

export type NavGroup = "Operación" | "Inventario" | "Clínica veterinaria" | "Agro" | "Farmacia" | "Administración";
export type NavIcon =
  | "home" | "cart" | "receipt" | "box" | "clock" | "truck" | "sparkles" | "users" | "paw" | "syringe"
  | "leaf" | "rx" | "book" | "chart" | "settings" | "bell";

export interface NavItem {
  href: string;
  label: string;
  module: ModuleKey;
  permission?: Permission;
  group: NavGroup;
  icon: NavIcon;
}

/** Menú: se filtra por módulos activos del tenant y permisos del rol. */
export const NAV: readonly NavItem[] = [
  { href: "/app", label: "Inicio", module: "CORE", group: "Operación", icon: "home" },
  { href: "/app/pos", label: "Punto de venta", module: "CORE", permission: "pos.sell", group: "Operación", icon: "cart" },
  { href: "/app/documents", label: "Comprobantes", module: "CORE", permission: "documents.read", group: "Operación", icon: "receipt" },
  { href: "/app/customers", label: "Clientes", module: "CORE", permission: "customers.manage", group: "Operación", icon: "users" },
  { href: "/app/inventory", label: "Productos y stock", module: "CORE", permission: "inventory.read", group: "Inventario", icon: "box" },
  { href: "/app/inventory/expiry", label: "Caducidad", module: "CORE", permission: "inventory.read", group: "Inventario", icon: "clock" },
  { href: "/app/purchases", label: "Compras", module: "CORE", permission: "purchases.manage", group: "Inventario", icon: "truck" },
  { href: "/app/purchases/ai", label: "Cargar factura (IA)", module: "AI_INVENTORY", permission: "purchases.ai_ingest", group: "Inventario", icon: "sparkles" },
  { href: "/app/vet/pets", label: "Pacientes", module: "VETERINARY", permission: "vet.records", group: "Clínica veterinaria", icon: "paw" },
  { href: "/app/vet/records/new", label: "Nueva historia clínica", module: "VETERINARY", permission: "vet.records", group: "Clínica veterinaria", icon: "book" },
  { href: "/app/vet/today", label: "Pacientes de hoy", module: "VETERINARY", permission: "vet.records", group: "Clínica veterinaria", icon: "clock" },
  { href: "/app/vet/vaccines", label: "Vacunas por vencer", module: "VETERINARY", permission: "vet.vaccinate", group: "Clínica veterinaria", icon: "syringe" },
  { href: "/app/agro/withdrawal", label: "Periodos de retiro", module: "AGRO", permission: "inventory.read", group: "Agro", icon: "leaf" },
  { href: "/app/agro/senasa", label: "Control SENASA", module: "AGRO", permission: "inventory.read", group: "Agro", icon: "book" },
  { href: "/app/pharmacy/prescriptions", label: "Recetas", module: "PHARMACY", permission: "pharmacy.dispense_rx", group: "Farmacia", icon: "rx" },
  { href: "/app/pharmacy/controlled", label: "Libro de controlados", module: "PHARMACY", permission: "pharmacy.controlled_log", group: "Farmacia", icon: "book" },
  { href: "/app/reports", label: "Reportes", module: "CORE", permission: "reports.read", group: "Administración", icon: "chart" },
  { href: "/app/settings", label: "Configuración", module: "CORE", permission: "settings.manage", group: "Administración", icon: "settings" },
  { href: "/app/settings/whatsapp", label: "WhatsApp", module: "CORE", permission: "settings.manage", group: "Administración", icon: "bell" },
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

/** Grupo del menú propio de cada rubro: se muestra primero, justo después de Operación. */
const LINE_GROUP: Partial<Record<BusinessLine, NavGroup>> = {
  PHARMACY: "Farmacia",
  VETERINARY: "Clínica veterinaria",
  AGROVET: "Agro",
};

export function visibleNav(modules: ReadonlySet<ModuleKey>, can: (p: Permission) => boolean, lines: readonly BusinessLine[] = []): NavItem[] {
  const items = NAV.filter((i) => modules.has(i.module) && (!i.permission || can(i.permission)));
  const first = lines.map((l) => LINE_GROUP[l]).filter((g): g is NavGroup => !!g);
  const rank = (g: NavGroup) => (g === "Operación" ? 0 : first.includes(g) ? 1 + first.indexOf(g) : 1 + first.length);
  return [...items].sort((a, b) => rank(a.group) - rank(b.group)); // sort estable: conserva el orden dentro de cada grupo
}

export interface QuickAction {
  href: string;
  label: string;
  description: string;
  icon: NavIcon;
  module: ModuleKey;
  permission: Permission;
}

/** Botones principales del inicio según el rubro del negocio. */
export const QUICK_ACTIONS: Partial<Record<BusinessLine, readonly QuickAction[]>> = {
  PHARMACY: [
    { href: "/app/pharmacy/prescriptions?nueva=controlada", label: "Validar receta controlada", description: "Registra la receta especial y al prescriptor", icon: "rx", module: "PHARMACY", permission: "pharmacy.dispense_rx" },
    { href: "/app/inventory/expiry", label: "Alertas de caducidad", description: "Lotes vencidos y por vencer", icon: "clock", module: "CORE", permission: "inventory.read" },
    { href: "/app/pos?otc=1", label: "Venta rápida OTC", description: "Solo productos de venta libre", icon: "cart", module: "CORE", permission: "pos.sell" },
  ],
  VETERINARY: [
    { href: "/app/vet/records/new", label: "Nueva historia clínica", description: "Atención de un paciente nuevo o registrado", icon: "book", module: "VETERINARY", permission: "vet.records" },
    { href: "/app/vet/pets", label: "Generar cartilla QR", description: "Cartilla de vacunación en PDF", icon: "syringe", module: "VETERINARY", permission: "vet.records" },
    { href: "/app/vet/today", label: "Pacientes de hoy", description: "Atenciones y vacunas del día", icon: "paw", module: "VETERINARY", permission: "vet.records" },
  ],
  AGROVET: [
    { href: "/app/agro/withdrawal", label: "Calculadora de retiro", description: "Fecha segura para carne y leche", icon: "leaf", module: "AGRO", permission: "inventory.read" },
    { href: "/app/agro/senasa", label: "Control SENASA", description: "Registros sanitarios de sus productos", icon: "book", module: "AGRO", permission: "inventory.read" },
  ],
};

/** Acciones del rubro que este usuario realmente puede usar (módulo activo y permiso del rol). */
export function quickActionsFor(lines: readonly BusinessLine[], modules: ReadonlySet<ModuleKey>, can: (p: Permission) => boolean): QuickAction[] {
  const seen = new Set<string>();
  return lines.flatMap((l) => QUICK_ACTIONS[l] ?? []).filter((a) => {
    if (!modules.has(a.module) || !can(a.permission) || seen.has(a.href)) return false;
    seen.add(a.href);
    return true;
  });
}

export const PATH_HEADER = "x-nx-path";

/** Permiso que exige una ruta del panel, según el menú (prefijo más largo). */
export function permissionForPath(pathWithSearch: string): Permission | null {
  const [pathname = "", search = ""] = pathWithSearch.split("?");
  if (pathname === "/app/reports" && new URLSearchParams(search).get("tab") === "ple") return "reports.accounting";
  const hit = NAV.filter((i) => i.href !== "/app" && (pathname === i.href || pathname.startsWith(`${i.href}/`)))
    .sort((a, b) => b.href.length - a.href.length)[0];
  return hit?.permission ?? null;
}

/** Módulos que dependen de otros. */
export const MODULE_DEPENDENCIES: Partial<Record<ModuleKey, ModuleKey[]>> = {
  MAGISTRAL: ["PHARMACY"],
};
