import { useMemo, useState } from "react";
import { orderBy, useCollection } from "../hooks";
import type { Asset, PositionDoc, TradingMode } from "../types";
import { ASSET_LABELS } from "../types";
import { pnlColor, pnlSign, formatTimeET, sideColor } from "../format";

export function TradeLogPage() {
  const { items: positions, loading } = useCollection<PositionDoc>(
    "positions",
    [orderBy("entryTime", "desc")]
  );
  const [assetFilter, setAssetFilter] = useState<Asset | "all">("all");
  const [modeFilter, setModeFilter] = useState<TradingMode | "all">("all");

  const filtered = useMemo(
    () =>
      positions.filter(
        (p) =>
          (assetFilter === "all" || p.asset === assetFilter) &&
          (modeFilter === "all" || p.mode === modeFilter)
      ),
    [positions, assetFilter, modeFilter]
  );

  return (
    <div>
      <div className="section-header">
        <h2 className="page-title" style={{ marginBottom: 0 }}>
          Trade Log
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
            value={modeFilter}
            onChange={(e) =>
              setModeFilter(e.target.value as TradingMode | "all")
            }
          >
            <option value="all">Live + dry-run</option>
            <option value="live">Live only</option>
            <option value="dry_run">Dry-run only</option>
          </select>
        </div>
      </div>

      <div className="card" style={{ padding: 0, overflow: "hidden" }}>
        {loading ? (
          <div className="empty-state">Loading…</div>
        ) : filtered.length === 0 ? (
          <div className="empty-state">No trades yet.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Asset</th>
                <th>Side</th>
                <th>Size</th>
                <th>Entry</th>
                <th>Exit</th>
                <th>Entry Time</th>
                <th>Exit Time</th>
                <th>Fee</th>
                <th>PnL</th>
                <th>Mode</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((p) => (
                <tr key={p.id}>
                  <td>{ASSET_LABELS[p.asset]}</td>
                  <td style={{ textTransform: "uppercase", color: sideColor(p.side) }}>
                    {p.side}
                  </td>
                  <td>{p.size}</td>
                  <td>{p.entryPrice}</td>
                  <td>{p.exitPrice ?? "—"}</td>
                  <td>{formatTimeET(p.entryTime)}</td>
                  <td>{formatTimeET(p.exitTime)}</td>
                  <td>{p.fee != null ? p.fee.toFixed(2) : "—"}</td>
                  <td>
                    {p.pnl != null ? (
                      <span style={{ color: pnlColor(p.pnl) }}>
                        {pnlSign(p.pnl)}
                        {p.pnl.toFixed(2)}
                      </span>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td>
                    <span className={`pill ${p.mode === "live" ? "amber" : "neutral"}`}>
                      {p.mode === "live" ? "live" : "dry-run"}
                    </span>
                  </td>
                  <td>
                    <span className={`pill ${p.status === "open" ? "green" : "neutral"}`}>
                      {p.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
