import { useMemo, useState } from "react";
import { orderBy, useCollection } from "../hooks";
import type { Asset, MissedEntryDoc, PositionDoc } from "../types";
import { ASSET_LABELS } from "../types";
import { pnlColor, pnlSign } from "../format";

type Timeframe = "7d" | "30d" | "3m" | "6m" | "1y" | "all";

const TIMEFRAME_LABELS: Record<Timeframe, string> = {
  "7d": "7 days",
  "30d": "30 days",
  "3m": "3 months",
  "6m": "6 months",
  "1y": "1 year",
  all: "All time",
};

const TIMEFRAME_DAYS: Record<Exclude<Timeframe, "all">, number> = {
  "7d": 7,
  "30d": 30,
  "3m": 90,
  "6m": 182,
  "1y": 365,
};

function withinTimeframe(date: Date, timeframe: Timeframe): boolean {
  if (timeframe === "all") return true;
  const now = new Date();
  const days = TIMEFRAME_DAYS[timeframe];
  return now.getTime() - date.getTime() <= days * 24 * 3600 * 1000;
}

function formatAxisTick(date: Date, spanMs: number): string {
  if (spanMs < 24 * 3600 * 1000) {
    return date.toLocaleTimeString("en-US", {
      timeZone: "America/New_York",
      hour: "numeric",
      minute: "2-digit",
    });
  }
  return date.toLocaleDateString("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
  });
}

interface EquityPoint {
  time: number;
  value: number;
}

function EquityCurve({ points }: { points: EquityPoint[] }) {
  if (points.length < 2) {
    return <div className="empty-state">Not enough closed trades yet.</div>;
  }

  const width = 900;
  const height = 340;
  const padLeft = 64;
  const padRight = 16;
  const padTop = 16;
  const padBottom = 32;
  const plotWidth = width - padLeft - padRight;
  const plotHeight = height - padTop - padBottom;

  const values = points.map((p) => p.value);
  const minV = Math.min(0, ...values);
  const maxV = Math.max(0, ...values);
  const rangeV = maxV - minV || 1;

  const times = points.map((p) => p.time);
  const minT = times[0];
  const maxT = times[times.length - 1];
  const rangeT = maxT - minT || 1;

  const x = (t: number) => padLeft + ((t - minT) / rangeT) * plotWidth;
  const y = (v: number) => padTop + plotHeight - ((v - minV) / rangeV) * plotHeight;

  const path = points
    .map((p, i) => `${i === 0 ? "M" : "L"} ${x(p.time)} ${y(p.value)}`)
    .join(" ");
  const zeroY = y(0);
  const last = values[values.length - 1];

  const yTickCount = 4;
  const yTicks = Array.from({ length: yTickCount + 1 }, (_, i) => minV + (rangeV * i) / yTickCount);

  const xTickCount = 4;
  const xTicks = Array.from({ length: xTickCount + 1 }, (_, i) => minT + (rangeT * i) / xTickCount);

  return (
    <svg viewBox={`0 0 ${width} ${height}`} width="100%" height={height}>
      {yTicks.map((v, i) => (
        <g key={i}>
          <line
            x1={padLeft}
            x2={width - padRight}
            y1={y(v)}
            y2={y(v)}
            stroke="var(--border-soft)"
            strokeWidth={1}
          />
          <text
            x={padLeft - 10}
            y={y(v)}
            textAnchor="end"
            dominantBaseline="middle"
            fontSize={11}
            fill="var(--text-faint)"
          >
            {v >= 0 ? "+" : ""}
            {v.toFixed(0)}
          </text>
        </g>
      ))}

      <line
        x1={padLeft}
        x2={width - padRight}
        y1={zeroY}
        y2={zeroY}
        stroke="var(--border)"
        strokeDasharray="4 4"
      />

      {xTicks.map((t, i) => (
        <text
          key={i}
          x={x(t)}
          y={height - 8}
          textAnchor="middle"
          fontSize={11}
          fill="var(--text-faint)"
        >
          {formatAxisTick(new Date(t), rangeT)}
        </text>
      ))}

      <path d={path} fill="none" stroke={pnlColor(last)} strokeWidth={2} />
    </svg>
  );
}

export function AnalysisPage() {
  const { items: positions } = useCollection<PositionDoc>("positions", [
    orderBy("exitTime", "asc"),
  ]);
  const { items: missed } = useCollection<MissedEntryDoc>("missedEntries", []);

  const [assetFilter, setAssetFilter] = useState<Asset | "all">("all");
  const [timeframe, setTimeframe] = useState<Timeframe>("all");

  const closed = useMemo(
    () =>
      positions.filter(
        (p) =>
          p.status === "closed" &&
          p.pnl != null &&
          p.exitTime &&
          (assetFilter === "all" || p.asset === assetFilter) &&
          withinTimeframe(new Date(p.exitTime.seconds * 1000), timeframe)
      ),
    [positions, assetFilter, timeframe]
  );

  const filteredMissed = useMemo(
    () =>
      missed.filter(
        (m) =>
          (assetFilter === "all" || m.asset === assetFilter) &&
          withinTimeframe(new Date(m.timestamp.seconds * 1000), timeframe)
      ),
    [missed, assetFilter, timeframe]
  );

  const equityPoints = useMemo(() => {
    let running = 0;
    return closed.map((p) => {
      running += p.pnl ?? 0;
      return { time: p.exitTime!.seconds * 1000, value: running };
    });
  }, [closed]);

  const combinedPnl = closed.reduce((sum, p) => sum + (p.pnl ?? 0), 0);
  const combinedWinRate = closed.length
    ? (closed.filter((p) => (p.pnl ?? 0) > 0).length / closed.length) * 100
    : 0;

  return (
    <div>
      <div className="section-header">
        <h2 className="page-title" style={{ marginBottom: 0 }}>
          Analysis
        </h2>
        <div className="filter-row">
          <select
            value={assetFilter}
            onChange={(e) => setAssetFilter(e.target.value as Asset | "all")}
          >
            <option value="all">All assets</option>
            {Object.entries(ASSET_LABELS).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
          <select
            value={timeframe}
            onChange={(e) => setTimeframe(e.target.value as Timeframe)}
          >
            {Object.entries(TIMEFRAME_LABELS).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="grid grid-4" style={{ marginBottom: 16, marginTop: 16 }}>
        <div className="card">
          <div className="card-label">Total PnL</div>
          <div className="card-value" style={{ color: pnlColor(combinedPnl) }}>
            {pnlSign(combinedPnl)}
            {combinedPnl.toFixed(2)}
          </div>
        </div>
        <div className="card">
          <div className="card-label">Win Rate</div>
          <div className="card-value">{combinedWinRate.toFixed(0)}%</div>
        </div>
        <div className="card">
          <div className="card-label">Closed Trades</div>
          <div className="card-value">{closed.length}</div>
        </div>
        <div className="card">
          <div className="card-label">Missed Entries</div>
          <div className="card-value">{filteredMissed.length}</div>
        </div>
      </div>

      <div className="card">
        <div className="card-label">Equity Curve</div>
        <EquityCurve points={equityPoints} />
      </div>
    </div>
  );
}
