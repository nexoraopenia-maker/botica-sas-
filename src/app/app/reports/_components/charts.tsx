"use client";

import { useEffect, useRef, useState } from "react";

const money = (v: number) => `S/ ${v.toLocaleString("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const compact = (v: number) => (v >= 1000 ? `${(v / 1000).toLocaleString("es-PE", { maximumFractionDigits: 1 })}K` : `${Math.round(v)}`);

/** Escala "bonita": 0 a un máximo redondeado con 4 divisiones limpias. */
function niceTicks(max: number): number[] {
  if (max <= 0) return [0, 1];
  const raw = max / 4;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? raw;
  return Array.from({ length: 5 }, (_, i) => i * step);
}

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(e!.contentRect.width));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

export interface DayPoint { date: string; total: number; docs: number }

/** Ventas por día: columnas de una serie (sin leyenda: el título la nombra), tooltip por columna. */
export function DailySalesChart({ data }: { data: DayPoint[] }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const H = 240, top = 12, bottom = 28, left = 44, right = 8;
  const ticks = niceTicks(Math.max(...data.map((d) => d.total), 0));
  const yMax = ticks.at(-1)!;
  const plotW = Math.max(width - left - right, 0);
  const plotH = H - top - bottom;
  const band = data.length ? plotW / data.length : 0;
  const barW = Math.min(24, Math.max(band - 2, 2)); // ≤ 24px, 2px de aire entre columnas
  const y = (v: number) => top + plotH - (v / yMax) * plotH;
  const labelEvery = Math.max(1, Math.ceil(data.length / Math.max(1, Math.floor(plotW / 46))));
  const fmtDay = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
  const h = hover !== null ? data[hover] : null;

  return (
    <div className="viz" ref={ref}>
      {width > 0 && (
        <svg width={width} height={H} role="img" aria-label="Ventas por día del periodo; detalle en la tabla">
          {ticks.map((t) => (
            <g key={t}>
              <line x1={left} x2={width - right} y1={y(t)} y2={y(t)} className="viz-grid" />
              <text x={left - 8} y={y(t)} className="viz-tick" textAnchor="end" dominantBaseline="middle">{compact(t)}</text>
            </g>
          ))}
          {data.map((d, i) => {
            const cx = left + band * i + band / 2;
            const hgt = d.total > 0 ? Math.max(2, (d.total / yMax) * plotH) : 0;
            const x0 = cx - barW / 2, y0 = top + plotH - hgt, r = Math.min(4, barW / 2, hgt);
            return (
              <g key={d.date}>
                {hgt > 0 && (
                  <path className={`viz-bar${hover === i ? " on" : ""}`}
                    d={`M${x0},${top + plotH} V${y0 + r} Q${x0},${y0} ${x0 + r},${y0} H${x0 + barW - r} Q${x0 + barW},${y0} ${x0 + barW},${y0 + r} V${top + plotH} Z`} />
                )}
                {i % labelEvery === 0 && <text x={cx} y={H - 8} className="viz-tick" textAnchor="middle">{fmtDay(d.date)}</text>}
                {/* Zona de interacción más grande que la marca */}
                <rect x={left + band * i} y={top} width={band} height={plotH} fill="transparent" tabIndex={0}
                  aria-label={`${fmtDay(d.date)}: ${money(d.total)}, ${d.docs} comprobantes`}
                  onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} onFocus={() => setHover(i)} onBlur={() => setHover(null)} />
              </g>
            );
          })}
          <line x1={left} x2={width - right} y1={top + plotH} y2={top + plotH} className="viz-axis" />
        </svg>
      )}
      {h && hover !== null && (
        <div className="viz-tip" style={{ left: Math.min(Math.max(left + band * hover + band / 2, 70), width - 70), top: y(h.total) - 8 }}>
          <strong>{new Date(`${h.date}T12:00:00`).toLocaleDateString("es-PE", { weekday: "short", day: "numeric", month: "short" })}</strong>
          <span>{money(h.total)}</span>
          <span className="viz-tip-sub">{h.docs} comprobante{h.docs === 1 ? "" : "s"}</span>
        </div>
      )}
    </div>
  );
}

/** Barras horizontales (magnitud por categoría, una serie): valor al final de la barra. */
export function BarList({ data }: { data: { label: string; value: number; sub?: string }[] }) {
  const max = Math.max(...data.map((d) => d.value), 0);
  return (
    <ul className="viz-barlist">
      {data.map((d) => (
        <li key={d.label} title={`${d.label}: ${money(d.value)}${d.sub ? ` · ${d.sub}` : ""}`}>
          <span className="viz-barlist-label">{d.label}</span>
          <span className="viz-barlist-track">
            <span className="viz-barlist-bar" style={{ width: `calc((100% - 150px) * ${max ? Math.max(d.value / max, 0.015) : 0})` }} />
            <span className="viz-barlist-value">{money(d.value)}{d.sub && <small> · {d.sub}</small>}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}
