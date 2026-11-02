import { describe, expect, it } from "vitest";
import { canTransition, daysBetween, deliveryBlocker, detectImage, orderCode, trafficLight } from "@/lib/services/rules";
import { renderTemplate } from "@/lib/notifications/templates";
import { permissionForPath, quickActionsFor, visibleNav } from "@/lib/modules/registry";
import { hasPermission, SYSTEM_ROLES } from "@/lib/auth/permissions";

describe("semáforo de vencimientos", () => {
  const today = "2026-11-02";
  it.each([
    ["2026-10-30", "overdue", -3, "Vencida hace 3 d"],
    ["2026-11-01", "overdue", -1, "Vencida hace 1 d"],
    ["2026-11-02", "soon", 0, "Vence hoy"],
    ["2026-11-05", "soon", 3, "Vence en 3 d"],
    ["2026-11-06", "ok", 4, "Al día · 4 d"],
    ["2027-01-01", "ok", 60, "Al día · 60 d"],
  ])("%s → %s", (due, light, days, label) => {
    expect(trafficLight(due, today, 3)).toEqual({ light, days, label });
  });
  it("respeta el plazo configurado", () => {
    expect(trafficLight("2026-11-09", today, 7).light).toBe("soon");
    expect(trafficLight("2026-11-09", today, 3).light).toBe("ok");
  });
  it("cuenta bien entre meses y años", () => {
    expect(daysBetween("2026-12-30", "2027-01-02")).toBe(3);
  });
});

describe("estados de la orden", () => {
  it("avanza o retrocede de a un paso", () => {
    expect(canTransition("RECEIVED", "IN_PROGRESS")).toBe(true);
    expect(canTransition("IN_PROGRESS", "RECEIVED")).toBe(true);
    expect(canTransition("READY", "DELIVERED")).toBe(true);
  });
  it("no salta pasos ni se queda en el mismo", () => {
    expect(canTransition("RECEIVED", "READY")).toBe(false);
    expect(canTransition("RECEIVED", "DELIVERED")).toBe(false);
    expect(canTransition("READY", "READY")).toBe(false);
  });
  it("entregado es definitivo", () => {
    expect(canTransition("DELIVERED", "READY")).toBe(false);
  });
});

describe("entrega", () => {
  it("al contado exige saldo cero", () => {
    expect(deliveryBlocker({ paymentType: "CASH", total: 100, balanceDue: 20, dueDate: null })).toMatch(/S\/ 20\.00/);
    expect(deliveryBlocker({ paymentType: "CASH", total: 100, balanceDue: 0, dueDate: null })).toBeNull();
  });
  it("a crédito se entrega con saldo, si hay monto y vencimiento", () => {
    expect(deliveryBlocker({ paymentType: "CREDIT", total: 100, balanceDue: 100, dueDate: "2026-12-01" })).toBeNull();
    expect(deliveryBlocker({ paymentType: "CREDIT", total: 0, balanceDue: 0, dueDate: "2026-12-01" })).toMatch(/monto/);
    expect(deliveryBlocker({ paymentType: "CREDIT", total: 100, balanceDue: 100, dueDate: null })).toMatch(/vencimiento/);
  });
});

describe("validación de fotos por contenido", () => {
  const bytes = (...v: number[]) => new Uint8Array([...v, ...new Array(20).fill(0)]);
  const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
  it("reconoce JPEG, PNG y WebP", () => {
    expect(detectImage(bytes(0xff, 0xd8, 0xff, 0xe0))?.contentType).toBe("image/jpeg");
    expect(detectImage(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))?.ext).toBe("png");
    expect(detectImage(bytes(...ascii("RIFF"), 1, 2, 3, 4, ...ascii("WEBP")))?.ext).toBe("webp");
  });
  it("rechaza lo demás aunque se llame .jpg", () => {
    expect(detectImage(new Uint8Array(Buffer.from("<script>alert(1)</script>........")))).toBeNull();
    expect(detectImage(new Uint8Array(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>")))).toBeNull();
    expect(detectImage(bytes(...ascii("%PDF-1.7")))).toBeNull();
    expect(detectImage(new Uint8Array())).toBeNull();
  });
});

describe("recordatorio de cobranza", () => {
  it("incluye saldo, orden y fecha", () => {
    const m = renderTemplate("payment_due_soon", { customerName: "Juan", balance: "150.00", order: orderCode(12), item: "Hilux", dueDate: "2026-11-05", business: "Taller Sur" });
    expect(m.text).toContain("S/ 150.00");
    expect(m.text).toContain("OS-000012");
    expect(m.text).toContain("05/11/2026");
    expect(m.waTemplate).toBe("recordatorio_cobranza");
    expect(m.waParams).toHaveLength(6);
  });
});

describe("taller en el panel", () => {
  const mods = new Set(["CORE", "WORKSHOP"] as const);
  const yes = () => true;
  it("muestra sus accesos solo con el módulo activo", () => {
    expect(quickActionsFor(["WORKSHOP"], mods, yes).map((a) => a.href)).toEqual(["/app/services/new", "/app/services", "/app/receivables"]);
    expect(quickActionsFor(["WORKSHOP"], new Set(["CORE"] as const), yes)).toEqual([]);
  });
  it("el menú pone primero el grupo Taller", () => {
    expect([...new Set(visibleNav(mods, yes, ["WORKSHOP"]).map((i) => i.group))].slice(0, 2)).toEqual(["Operación", "Taller"]);
  });
  it("cada ruta exige su permiso", () => {
    expect(permissionForPath("/app/services/new")).toBe("services.manage");
    expect(permissionForPath("/app/receivables?ver=vencidas")).toBe("receivables.manage");
  });
  it("mecánico y cajero recepcionan, pero no gestionan la cartera", () => {
    for (const role of ["mechanic", "cashier"]) {
      const p = SYSTEM_ROLES[role]!.permissions as readonly string[];
      expect(hasPermission(p, "services.manage")).toBe(true);
      expect(hasPermission(p, "receivables.manage")).toBe(false);
    }
    expect(hasPermission(SYSTEM_ROLES.accountant!.permissions as readonly string[], "receivables.manage")).toBe(true);
  });
});
