import { useMemo } from "react";
import { orderBy, useCollection } from "../hooks";
import type { Asset, MissedEntryDoc, PositionDoc } from "../types";
import { ASSET_LABELS } from "../types";

const ASSETS: Asset[] = ["btc", "tech", "ai", "china"];

function EquityCurve({ points }: { points: number[] }) {
  if (points.length < 2) {
    return <div className="empty-state">Not enough closed trades yet.</div>;
  }
  const width = 800;
  const height = 220;
  const min = Math.min(0, ...points);
  const max = Math.max(0, ...points);
  const range = max - min || 1;
  const stepX = width / (points.length - 1);
  const toY = (v: number) => height - ((v - min) / range) * height;

  const path = points
    .map((v, i) => `${i === 0 ? "M" : "L"} ${i * stepX} ${toY(v)}`)
    .join(" ");
  const zeroY = toY(0);
  const last = points[points.length - 1];

  return (
    <svg viewBox={`0 0 ${width} ${height}`} width="100%" height={height}>
      <line
        x1={0}
        x2={width}
        y1={zeroY}
        y2={zeroY}
        stroke="var(--border)"
        strokeDasharray="4 4"
      />
      <path
        d={path}
        fill="none"
        stroke={last >= 0 ? "var(--green)" : "var(--red)"}
        strokeWidth={2}
      />
    </svg>
  );
}

export function AnalysisPage() {
  const { items: positions } = useCollection<PositionDoc>("positions", [
    orderBy("exitTime", "asc"),
  ]);
  const { items: missed } = useCollection<MissedEntryDoc>("missedEntries", []);

  const closed = useMemo(
    () => positions.filter((p) => p.status === "closed" && p.pnl != null),
    [positions]
  );

  const equityPoints = useMemo(() => {
    let running = 0;
    return closed.map((p) => (running += p.pnl ?? 0));
  }, [closed]);

  const perAsset = useMemo(() => {
    return ASSETS.map((asset) => {
      const trades = closed.filter((p) => p.asset === asset);
      const wins = trades.filter((p) => (p.pnl ?? 0) > 0);
      const totalPnl = trades.reduce((sum, p) => sum + (p.pnl ?? 0), 0);
      const winRate = trades.length ? (wins.length / trades.length) * 100 : 0;
      return { asset, count: trades.length, winRate, totalPnl };
    });
  }, [closed]);

  const missedByReason = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const m of missed) counts[m.reason] = (counts[m.reason] ?? 0) + 1;
    return counts;
  }, [missed]);

  const combinedPnl = closed.reduce((sum, p) => sum + (p.pnl ?? 0), 0);
  const combinedWinRate = closed.length
    ? (closed.filter((p) => (p.pnl ?? 0) > 0).length / closed.length) * 100
    : 0;

  return (
    <div>
      <h2 className="page-title">Analysis</h2>

      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <div className="card">
          <div className="card-label">Total PnL</div>
          <div className={`card-value ${combinedPnl >= 0 ? "green" : "red"}`}>
            {combinedPnl >= 0 ? "+" : ""}
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
          <div className="card-value">{missed.length}</div>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-label">Equity Curve</div>
        <EquityCurve points={equityPoints} />
      </div>

      <div className="grid grid-2" style={{ marginBottom: 16 }}>
        <div className="card">
          <div className="card-label">Per-Asset Performance</div>
          <table>
            <thead>
              <tr>
                <th>Asset</th>
                <th>Trades</th>
                <th>Win Rate</th>
                <th>PnL</th>
              </tr>
            </thead>
            <tbody>
              {perAsset.map((row) => (
                <tr key={row.asset}>
                  <td>{ASSET_LABELS[row.asset]}</td>
                  <td>{row.count}</td>
                  <td>{row.count ? `${row.winRate.toFixed(0)}%` : "—"}</td>
                  <td>
                    <span
                      style={{
                        color: row.totalPnl >= 0 ? "var(--green)" : "var(--red)",
                      }}
                    >
                      {row.count ? `${row.totalPnl >= 0 ? "+" : ""}${row.totalPnl.toFixed(2)}` : "—"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="card">
          <div className="card-label">Missed / Blocked Signal Breakdown</div>
          {Object.keys(missedByReason).length === 0 ? (
            <div className="empty-state">No missed entries.</div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Reason</th>
                  <th>Count</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(missedByReason).map(([reason, count]) => (
                  <tr key={reason}>
                    <td>{reason.replace(/_/g, " ")}</td>
                    <td>{count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
