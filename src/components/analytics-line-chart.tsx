"use client";

import { useMemo, useState } from "react";

export type LineChartPoint = {
  date: string;
  value: number;
};

type Props = {
  data: LineChartPoint[];
  formatValue?: (value: number) => string;
  formatDate?: (date: string) => string;
  height?: number;
  /** Tailwind color tokens for the line/fill -- default matches this app's own indigo accent
   * (`bg-indigo-600`/`bg-indigo-500`, already the dominant action color elsewhere in the UI). */
  colorClassName?: string;
};

const VIEWBOX_WIDTH = 600;

/**
 * A single-series time-series line chart, built as inline SVG rather than a new chart-library
 * dependency (none exists in `package.json` today, and this app's own convention -- no other
 * component pulls in a UI library beyond what's already installed -- weighs against adding one
 * for a single chart shape). Follows the dataviz skill's mark spec: a thin 2px line, a subtle
 * gradient area fill anchored to the baseline, recessive gridlines, and a hover crosshair+tooltip
 * (a line/area chart ships hover by default, per that skill's interaction reference) -- never a
 * dual axis, never more than one hue for this single series.
 *
 * Accessibility fallback (dataviz skill §6: "a table view exists"): the caller is responsible for
 * also rendering the underlying data as a table somewhere on the page -- `channel-overview-panel.tsx`
 * keeps the pre-existing raw metrics table available via "Show raw collected data" for exactly
 * this reason, rather than this component re-implementing its own table mode.
 */
export function AnalyticsLineChart({
  data,
  formatValue = (v) => v.toLocaleString(),
  formatDate = (d) => d,
  height = 180,
  colorClassName = "text-indigo-400",
}: Props) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const { points, maxValue, minValue } = useMemo(() => {
    if (data.length === 0) return { points: [] as Array<{ x: number; y: number }>, maxValue: 0, minValue: 0 };
    const values = data.map((d) => d.value);
    const max = Math.max(...values, 0);
    const min = Math.min(...values, 0);
    const range = max - min || 1;
    const step = data.length > 1 ? VIEWBOX_WIDTH / (data.length - 1) : 0;
    const pts = data.map((d, i) => ({
      x: data.length > 1 ? i * step : VIEWBOX_WIDTH / 2,
      y: height - ((d.value - min) / range) * (height - 24) - 12,
    }));
    return { points: pts, maxValue: max, minValue: min };
  }, [data, height]);

  if (data.length === 0) {
    return (
      <div
        className="flex items-center justify-center rounded-lg border border-zinc-800 bg-zinc-950/40 text-sm text-zinc-500"
        style={{ height }}
      >
        No data for this period yet.
      </div>
    );
  }

  const linePath = points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(" ");
  const areaPath = `${linePath} L${points[points.length - 1].x.toFixed(2)},${height} L${points[0].x.toFixed(2)},${height} Z`;

  const gridLineCount = 4;
  const gridLines = Array.from({ length: gridLineCount + 1 }, (_, i) => (i / gridLineCount) * height);

  const hovered = hoverIndex !== null ? data[hoverIndex] : null;
  const hoveredPoint = hoverIndex !== null ? points[hoverIndex] : null;

  return (
    <div className={`relative ${colorClassName}`}>
      <svg
        viewBox={`0 0 ${VIEWBOX_WIDTH} ${height}`}
        preserveAspectRatio="none"
        className="w-full"
        style={{ height }}
        onMouseLeave={() => setHoverIndex(null)}
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const relativeX = ((e.clientX - rect.left) / rect.width) * VIEWBOX_WIDTH;
          let closest = 0;
          let closestDist = Infinity;
          points.forEach((p, i) => {
            const dist = Math.abs(p.x - relativeX);
            if (dist < closestDist) {
              closestDist = dist;
              closest = i;
            }
          });
          setHoverIndex(closest);
        }}
      >
        {gridLines.map((y) => (
          <line key={y} x1={0} y1={y} x2={VIEWBOX_WIDTH} y2={y} stroke="currentColor" strokeOpacity={0.08} strokeWidth={1} className="text-zinc-500" />
        ))}

        <defs>
          <linearGradient id="analytics-line-chart-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="currentColor" stopOpacity={0.28} />
            <stop offset="100%" stopColor="currentColor" stopOpacity={0} />
          </linearGradient>
        </defs>

        <path d={areaPath} fill="url(#analytics-line-chart-fill)" stroke="none" />
        <path d={linePath} fill="none" stroke="currentColor" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />

        {hoveredPoint && (
          <>
            <line
              x1={hoveredPoint.x}
              y1={0}
              x2={hoveredPoint.x}
              y2={height}
              stroke="currentColor"
              strokeOpacity={0.35}
              strokeWidth={1}
            />
            <circle cx={hoveredPoint.x} cy={hoveredPoint.y} r={4} fill="currentColor" stroke="#18181b" strokeWidth={2} />
          </>
        )}
      </svg>

      {hovered && hoveredPoint && (
        <div
          className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full rounded-lg border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-xs shadow-lg"
          style={{
            left: `${(hoveredPoint.x / VIEWBOX_WIDTH) * 100}%`,
            top: `${Math.max(0, (hoveredPoint.y / height) * 100 - 4)}%`,
          }}
        >
          <div className="text-zinc-400">{formatDate(hovered.date)}</div>
          <div className="font-medium text-zinc-100">{formatValue(hovered.value)}</div>
        </div>
      )}

      <div className="mt-1 flex items-center justify-between text-[11px] text-zinc-500">
        <span>{formatDate(data[0]?.date ?? "")}</span>
        <span>{formatDate(data[data.length - 1]?.date ?? "")}</span>
      </div>

      {/* Screen-reader-only max/min so the two data points anchoring the visual scale are not
          color-only information -- matches the dataviz skill's "text wears text tokens" rule. */}
      <span className="sr-only">
        Range: {formatValue(minValue)} to {formatValue(maxValue)}.
      </span>
    </div>
  );
}
