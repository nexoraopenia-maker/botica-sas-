/** Etiquetas y reglas de UI (sin dependencias de servidor: se usa en componentes cliente). */
export const MODULES = [
  { key: "CORE", label: "Núcleo", hint: "POS, inventario por lotes, facturación SUNAT, compras, alertas", locked: true },
  { key: "PHARMACY", label: "Farmacia", hint: "Recetas, controlados, DCI y genéricos, fraccionamiento" },
  { key: "VETERINARY", label: "Veterinaria", hint: "Pacientes, historia clínica, carnet y recordatorios de vacunas" },
  { key: "AGRO", label: "Agro", hint: "Registro SENASA, periodos de retiro, especie destino" },
  { key: "AI_INVENTORY", label: "IA de inventario", hint: "Carga de facturas de compra desde foto, PDF o XML" },
  { key: "WHATSAPP", label: "WhatsApp", hint: "Recordatorios a propietarios por WhatsApp" },
  { key: "MAGISTRAL", label: "Preparados magistrales", hint: "Requiere Farmacia", requires: "PHARMACY" },
  { key: "DISPATCH_GUIDES", label: "Guías de remisión", hint: "Guías electrónicas de remisión" },
] as const;

export type ModuleKeyUI = (typeof MODULES)[number]["key"];

export const BUSINESS_LINES = [
  { key: "AGROVET", label: "Agroveterinaria" },
  { key: "VETERINARY", label: "Veterinaria" },
  { key: "PHARMACY", label: "Botica / Farmacia" },
  { key: "RETAIL", label: "Comercio general" },
] as const;

export type BusinessLineUI = (typeof BUSINESS_LINES)[number]["key"];

/** Misma regla que el backend (LINE_MODULES): sugerencia inicial de módulos por rubro. */
const LINE_MODULES: Record<BusinessLineUI, ModuleKeyUI[]> = {
  AGROVET: ["AGRO", "VETERINARY"],
  VETERINARY: ["VETERINARY"],
  PHARMACY: ["PHARMACY"],
  RETAIL: [],
};

export function suggestedModules(lines: BusinessLineUI[], planModules: string[]): ModuleKeyUI[] {
  const set = new Set<ModuleKeyUI>(["CORE"]);
  for (const l of lines) for (const m of LINE_MODULES[l]) set.add(m);
  for (const m of planModules) if (MODULES.some((x) => x.key === m)) set.add(m as ModuleKeyUI);
  return [...set];
}

export const STATUS_LABEL: Record<string, { label: string; tone: "" | "warn" | "bad" | "ok" }> = {
  TRIAL: { label: "Prueba", tone: "warn" },
  ACTIVE: { label: "Activo", tone: "ok" },
  SUSPENDED: { label: "Suspendido", tone: "bad" },
  PENDING_DELETION: { label: "Por eliminar", tone: "bad" },
  DELETED: { label: "Eliminado", tone: "bad" },
};

export function slugify(text: string, ruc: string): string {
  const base = text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30)
    .replace(/-+$/g, "");
  return [base || "cliente", ruc.slice(-4)].filter(Boolean).join("-");
}
