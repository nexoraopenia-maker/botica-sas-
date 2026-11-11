import { describe, expect, it } from "vitest";
import { isSellableLot, lotStatus, olderLotThan, suggestLot, type LotInfo } from "@/lib/inventory/expiry-rules";

const TODAY = "2026-11-12";
const lot = (id: string, expiry: string | null, over: Partial<LotInfo> = {}): LotInfo => ({ id, code: id.toUpperCase(), expiry, stock: "10", quarantined: false, ...over });

describe("estado del lote", () => {
  it("vencido solo después de su fecha: el último día todavía se vende", () => {
    expect(lotStatus({ expiry: "2026-11-11", quarantined: false }, TODAY)).toBe("expired");
    expect(lotStatus({ expiry: "2026-11-12", quarantined: false }, TODAY)).toBe("critical");
  });
  it("crítico hasta 30 días inclusive; después, normal", () => {
    expect(lotStatus({ expiry: "2026-12-12", quarantined: false }, TODAY)).toBe("critical"); // 30 días
    expect(lotStatus({ expiry: "2026-12-13", quarantined: false }, TODAY)).toBe("ok"); // 31 días
  });
  it("sin vencimiento es normal; la cuarentena prevalece sobre la fecha", () => {
    expect(lotStatus({ expiry: null, quarantined: false }, TODAY)).toBe("ok");
    expect(lotStatus({ expiry: "2030-01-01", quarantined: true }, TODAY)).toBe("quarantined");
  });
  it("no es vendible si está vencido, en cuarentena o sin stock", () => {
    expect(isSellableLot(lot("a", "2026-11-11"), TODAY)).toBe(false);
    expect(isSellableLot(lot("b", "2027-01-01", { quarantined: true }), TODAY)).toBe(false);
    expect(isSellableLot(lot("c", "2027-01-01", { stock: "0" }), TODAY)).toBe(false);
    expect(isSellableLot(lot("d", "2027-01-01"), TODAY)).toBe(true);
  });
});

describe("lote sugerido (FEFO)", () => {
  it("sugiere el vendible que vence antes, sin importar el orden recibido", () => {
    const lots = [lot("tarde", "2028-01-01"), lot("pronto", "2026-12-01"), lot("medio", "2027-06-01")];
    expect(suggestLot(lots, TODAY)?.id).toBe("pronto");
  });
  it("salta los vencidos, los de cuarentena y los agotados", () => {
    const lots = [lot("vencido", "2026-10-01"), lot("cuarentena", "2026-11-20", { quarantined: true }), lot("agotado", "2026-11-25", { stock: "0" }), lot("bueno", "2027-03-01")];
    expect(suggestLot(lots, TODAY)?.id).toBe("bueno");
  });
  it("un lote sin vencimiento va después de los que sí vencen", () => {
    expect(suggestLot([lot("sin", null), lot("con", "2030-01-01")], TODAY)?.id).toBe("con");
    expect(suggestLot([lot("sin", null)], TODAY)?.id).toBe("sin");
  });
  it("sin lotes vendibles no sugiere ninguno", () => {
    expect(suggestLot([], TODAY)).toBeNull();
    expect(suggestLot([lot("vencido", "2026-10-01")], TODAY)).toBeNull();
  });
  it("a igual fecha respeta el orden recibido (el más antiguo ingresado primero)", () => {
    expect(suggestLot([lot("primero", "2027-01-01"), lot("segundo", "2027-01-01")], TODAY)?.id).toBe("primero");
  });
});

describe("aviso de un lote más antiguo", () => {
  const lots = [lot("a", "2026-12-01"), lot("b", "2027-06-01"), lot("c", "2026-10-01")];
  it("si se elige uno más nuevo, señala el más antiguo vendible", () => {
    expect(olderLotThan(lots[1]!, lots, TODAY)?.id).toBe("a");
  });
  it("no avisa si ya es el más antiguo, y no cuenta los vencidos", () => {
    expect(olderLotThan(lots[0]!, lots, TODAY)).toBeNull(); // «c» está vencido: no cuenta
  });
});
