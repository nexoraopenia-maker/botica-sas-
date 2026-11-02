"use client";

import { useState } from "react";
import { withdrawalStatus } from "@/lib/agro/withdrawal";
import { limaToday } from "@/app/app/pharmacy/_components/today";

export interface WithdrawalProduct { id: string; name: string; meat: number | null; milk: number | null }

const dmy = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

/** Calcula desde cuándo la carne o la leche del animal tratado pueden destinarse a consumo humano. */
export function WithdrawalCalculator({ products }: { products: WithdrawalProduct[] }) {
  const today = limaToday();
  const [id, setId] = useState(products[0]?.id ?? "");
  const [date, setDate] = useState(today);
  const p = products.find((x) => x.id === id);
  const rows = p ? ([["Carne", p.meat], ["Leche", p.milk]] as const) : [];
  return (
    <div className="set-form">
      <label className="set-field"><span>Producto aplicado</span>
        <select value={id} onChange={(e) => setId(e.target.value)}>{products.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
      <label className="set-field"><span>Fecha de la última aplicación</span>
        <input type="date" value={date} max={today} onChange={(e) => setDate(e.target.value)} /></label>
      <div className="wide withdrawal-results">
        {date && rows.map(([label, days]) => {
          if (!days) return <div key={label} className="withdrawal-card"><span>{label}</span><strong>Sin periodo registrado</strong><small>Confirme en la etiqueta del producto.</small></div>;
          const s = withdrawalStatus(date, days, today);
          return (
            <div key={label} className={`withdrawal-card ${s.safe ? "ok" : "bad"}`}>
              <span>{label} · {days} días de retiro</span>
              <strong>Desde el {dmy(s.safeFrom)}</strong>
              <small>{s.safe ? "El periodo de retiro ya se cumplió." : `Faltan ${s.daysLeft} día(s): no destinar a consumo humano.`}</small>
            </div>
          );
        })}
      </div>
    </div>
  );
}
