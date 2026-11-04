"use client";

import { useState } from "react";
import { inrCompact, num } from "@/lib/format";

/**
 * Stacked bar chart (one bar per month, one segment per platform).
 * Colours: reference categorical palette in fixed order, one slot per platform,
 * so a platform keeps its colour on every chart. 2px surface gaps between
 * segments, legend above, hover tooltip per bar, and a table view for readers
 * who can't separate the colours.
 */

const SERIES_ORDER = ["Spotify", "YouTube Music", "JioSaavn", "Apple Music", "Gaana"];
const SERIES_VAR = ["--series-1", "--series-2", "--series-3", "--series-4", "--series-5"];

export interface StackedPoint {
  x: string; // label for the bar, e.g. "Oct 2025"
  series: string;
  value: number;
}

export function StackedBars({
  data,
  unit,
  height = 220,
  label,
}: {
  data: StackedPoint[];
  unit: "inr" | "count";
  height?: number;
  label: string;
}) {
  const format = (n: number) => (unit === "inr" ? inrCompact(n) : num(Math.round(n)));
  const [hover, setHover] = useState<number | null>(null);
  const [asTable, setAsTable] = useState(false);

  const xs = [...new Set(data.map((d) => d.x))];
  const series = SERIES_ORDER.filter((s) => data.some((d) => d.series === s));
  const value = (x: string, s: string) => data.find((d) => d.x === x && d.series === s)?.value ?? 0;
  const totals = xs.map((x) => series.reduce((sum, s) => sum + value(x, s), 0));
  const max = Math.max(1, ...totals);

  const W = 720;
  const padL = 64;
  const padB = 24;
  const plotH = height - padB - 8;
  const slot = (W - padL) / Math.max(1, xs.length);
  const barW = Math.min(36, slot * 0.6);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => t * max);
  const color = (s: string) => `var(${SERIES_VAR[SERIES_ORDER.indexOf(s)]})`;

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
        {series.map((s) => (
          <span key={s} className="inline-flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: color(s) }} />
            {s}
          </span>
        ))}
        <button type="button" className="ml-auto underline-offset-2 hover:underline" onClick={() => setAsTable((v) => !v)}>
          {asTable ? "Show chart" : "Show as table"}
        </button>
      </div>

      {asTable ? (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-muted">
                <th className="py-1 text-left font-medium">Month</th>
                {series.map((s) => (
                  <th key={s} className="py-1 text-right font-medium">{s}</th>
                ))}
                <th className="py-1 text-right font-medium">Total</th>
              </tr>
            </thead>
            <tbody>
              {xs.map((x, i) => (
                <tr key={x} className="border-t border-border">
                  <td className="py-1">{x}</td>
                  {series.map((s) => (
                    <td key={s} className="num py-1 text-right">{format(value(x, s))}</td>
                  ))}
                  <td className="num py-1 text-right font-medium">{format(totals[i])}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="relative">
          <svg viewBox={`0 0 ${W} ${height}`} className="w-full" role="img" aria-label={label}>
            {ticks.map((t) => {
              const y = 8 + plotH - (t / max) * plotH;
              return (
                <g key={t}>
                  <line x1={padL} x2={W} y1={y} y2={y} stroke="var(--border)" strokeWidth={1} />
                  <text x={padL - 8} y={y + 4} textAnchor="end" fontSize={11} fill="var(--muted)">
                    {format(t)}
                  </text>
                </g>
              );
            })}
            {xs.map((x, i) => {
              const cx = padL + slot * i + slot / 2;
              let y = 8 + plotH;
              return (
                <g key={x} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
                  {/* hit target wider than the bar */}
                  <rect x={padL + slot * i} y={8} width={slot} height={plotH} fill="transparent" />
                  {series.map((s, si) => {
                    const h = (value(x, s) / max) * plotH;
                    y -= h;
                    const top = si === series.length - 1;
                    return h > 0 ? (
                      <rect
                        key={s}
                        x={cx - barW / 2}
                        y={y}
                        width={barW}
                        height={Math.max(0, h - 2)}
                        rx={top ? 4 : 0}
                        fill={color(s)}
                        opacity={hover === null || hover === i ? 1 : 0.45}
                      />
                    ) : null;
                  })}
                  <text x={cx} y={height - 6} textAnchor="middle" fontSize={11} fill="var(--muted)">
                    {xs.length > 8 ? x.slice(0, 3) : x}
                  </text>
                </g>
              );
            })}
          </svg>
          {hover !== null && (
            <div
              className="pointer-events-none absolute top-2 z-10 min-w-44 rounded-lg border border-border bg-white p-2 text-xs shadow-md"
              style={{ left: `${Math.min(70, ((padL + slot * hover + slot) / W) * 100)}%` }}
            >
              <div className="mb-1 font-semibold">{xs[hover]}</div>
              {series.map((s) => (
                <div key={s} className="flex items-center justify-between gap-3">
                  <span className="inline-flex items-center gap-1.5 text-muted">
                    <span className="inline-block h-2 w-2 rounded-sm" style={{ background: color(s) }} />
                    {s}
                  </span>
                  <span className="num">{format(value(xs[hover], s))}</span>
                </div>
              ))}
              <div className="mt-1 flex justify-between border-t border-border pt-1 font-medium">
                <span>Total</span>
                <span className="num">{format(totals[hover])}</span>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
