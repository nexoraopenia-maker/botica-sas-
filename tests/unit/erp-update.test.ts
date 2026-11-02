import { describe, expect, it } from "vitest";
import { computeClosure } from "@/lib/pos/cash-closure-calc";
import { withdrawalEnd, withdrawalStatus } from "@/lib/agro/withdrawal";
import { permissionForPath, quickActionsFor, visibleNav } from "@/lib/modules/registry";
import { hasPermission, SYSTEM_ROLES } from "@/lib/auth/permissions";

describe("arqueo de caja", () => {
  it("suma el fondo inicial solo al efectivo y calcula el descuadre", () => {
    const r = computeClosure("100", { EFECTIVO: "50.50", YAPE: "20", PLIN: "0", TARJETA: "10" }, { EFECTIVO: "145", YAPE: "20", PLIN: "0", TARJETA: "10" });
    expect(r.lines[0]).toEqual({ method: "EFECTIVO", expected: "150.50", counted: "145.00", difference: "-5.50" });
    expect(r.lines[1]!.difference).toBe("0.00");
    expect(r.expectedTotal).toBe("180.50");
    expect(r.difference).toBe("-5.50");
  });
  it("sin descuadre la diferencia es cero aunque haya decimales", () => {
    expect(computeClosure(0, { EFECTIVO: "0.1", YAPE: "0.2", PLIN: 0, TARJETA: 0 }, { EFECTIVO: "0.1", YAPE: "0.2", PLIN: 0, TARJETA: 0 }).difference).toBe("0.00");
  });
});

describe("periodo de retiro", () => {
  it("cuenta los días desde la última aplicación, incluso entre meses", () => {
    expect(withdrawalEnd("2026-10-25", 14)).toBe("2026-11-08");
  });
  it("indica si ya se cumplió", () => {
    expect(withdrawalStatus("2026-10-25", 14, "2026-11-01")).toEqual({ safeFrom: "2026-11-08", daysLeft: 7, safe: false });
    expect(withdrawalStatus("2026-10-01", 14, "2026-11-01").safe).toBe(true);
  });
});

describe("panel adaptado al rubro", () => {
  const all = new Set(["CORE", "VETERINARY", "AGRO", "PHARMACY"] as const);
  const yes = () => true;
  it.each([
    ["PHARMACY", ["Validar receta controlada", "Alertas de caducidad", "Venta rápida OTC"]],
    ["VETERINARY", ["Nueva historia clínica", "Generar cartilla QR", "Pacientes de hoy"]],
    ["AGROVET", ["Calculadora de retiro", "Control SENASA"]],
  ] as const)("%s muestra sus accesos", (line, labels) => {
    expect(quickActionsFor([line], all, yes).map((a) => a.label)).toEqual(labels);
  });
  it("no ofrece acciones de un módulo inactivo ni sin permiso", () => {
    expect(quickActionsFor(["PHARMACY"], new Set(["CORE"] as const), yes).map((a) => a.label)).toEqual(["Alertas de caducidad", "Venta rápida OTC"]);
    const cashier = SYSTEM_ROLES.cashier!.permissions as readonly string[];
    expect(quickActionsFor(["PHARMACY"], all, (p) => hasPermission(cashier, p)).map((a) => a.label)).not.toContain("Validar receta controlada");
  });
  it("el menú pone primero el grupo del rubro", () => {
    const groups = [...new Set(visibleNav(all, yes, ["AGROVET"]).map((i) => i.group))];
    expect(groups.slice(0, 2)).toEqual(["Operación", "Agro"]);
  });
});

describe("permiso por ruta", () => {
  it.each([
    ["/app/settings", "settings.manage"],
    ["/app/settings/whatsapp", "settings.manage"],
    ["/app/settings?tab=users", "settings.manage"],
    ["/app/reports", "reports.read"],
    ["/app/reports?tab=ple&period=2026-10", "reports.accounting"],
    ["/app/customers/123", "customers.manage"],
    ["/app", null],
    ["/app/settingsx", null],
  ])("%s → %s", (path, perm) => expect(permissionForPath(path)).toBe(perm));
});

describe("permisos del cajero", () => {
  const cashier = SYSTEM_ROLES.cashier!.permissions as readonly string[];
  it("no puede acceder a configuración ni exportar PLE", () => {
    expect(hasPermission(cashier, "settings.manage")).toBe(false);
    expect(hasPermission(cashier, "reports.accounting")).toBe(false);
    expect(hasPermission(cashier, "pos.sell")).toBe(true);
  });
});
