/** Catálogo de permisos. Los roles guardan un subconjunto en roles.permissions ('*' = todos). */
export const PERMISSIONS = [
  "pos.sell",
  "pos.void",
  "pos.discount",
  "documents.read",
  "documents.credit_note",
  "inventory.read",
  "inventory.adjust",
  "inventory.waste",
  "purchases.manage",
  "purchases.ai_ingest",
  "customers.manage",
  "products.manage",
  "reports.read",
  "reports.accounting",
  "vet.records",
  "vet.vaccinate",
  "pharmacy.dispense_rx",
  "pharmacy.controlled_log",
  "services.manage",
  "receivables.manage",
  "users.manage",
  "settings.manage",
  "audit.read",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const SYSTEM_ROLES: Record<string, { name: string; permissions: readonly (Permission | "*")[] }> = {
  admin: { name: "Administrador", permissions: ["*"] },
  cashier: {
    name: "Cajero / Vendedor",
    permissions: ["pos.sell", "documents.read", "customers.manage", "inventory.read", "services.manage"],
  },
  warehouse: {
    name: "Almacenero",
    permissions: ["inventory.read", "inventory.adjust", "inventory.waste", "purchases.manage", "purchases.ai_ingest", "products.manage"],
  },
  veterinarian: {
    name: "Médico veterinario",
    permissions: ["vet.records", "vet.vaccinate", "pos.sell", "customers.manage", "inventory.read", "documents.read"],
  },
  pharmacist: {
    name: "Químico farmacéutico (DT)",
    permissions: [
      "pharmacy.dispense_rx", "pharmacy.controlled_log", "pos.sell", "pos.void", "inventory.read",
      "inventory.adjust", "inventory.waste", "purchases.manage", "products.manage", "documents.read",
    ],
  },
  mechanic: {
    name: "Mecánico / Recepción",
    permissions: ["services.manage", "customers.manage", "inventory.read"],
  },
  accountant: {
    name: "Contador",
    permissions: ["documents.read", "reports.read", "reports.accounting", "audit.read", "receivables.manage"],
  },
};

export function hasPermission(granted: readonly string[], needed: Permission): boolean {
  return granted.includes("*") || granted.includes(needed);
}
