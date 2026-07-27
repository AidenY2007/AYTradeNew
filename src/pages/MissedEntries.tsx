import { useMemo, useState } from "react";
import { orderBy, useCollection } from "../hooks";
import type { Asset, MissedEntryDoc, MissedEntryReason } from "../types";
import { ASSET_LABELS } from "../types";
import { formatTimeET, sideColor } from "../format";

const REASON_LABELS: Record<string, string> = {
  position_already_open: "Position already open",
  timing_restricted: "Timing restricted",
  kill_switch_active: "Kill switch active",
  daily_loss_limit: "Daily loss limit hit",
  invalid_payload: "Invalid webhook payload",
  market_session_closed: "Market session closed",
};

export function MissedEntriesPage() {
  const { items, loading } = useCollection<MissedEntryDoc>("missedEntries", [
    orderBy("timestamp", "desc"),
  ]);
  const [assetFilter, setAssetFilter] = useState<Asset | "all">("all");
  const [reasonFilter, setReasonFilter] = useState<MissedEntryReason | "all">(
    "all"
  );

  const filtered = useMemo(
    () =>
      items.filter(
        (item) =>
          (assetFilter === "all" || item.asset === assetFilter) &&
          (reasonFilter === "all" || item.reason === reasonFilter)
      ),
    [items, assetFilter, reasonFilter]
  );

  return (
    <div>
      <div className="section-header">
        <h2 className="page-title" style={{ marginBottom: 0 }}>
          Missed Entries
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
            value={reasonFilter}
            onChange={(e) =>
              setReasonFilter(e.target.value as MissedEntryReason | "all")
            }
          >
            <option value="all">All reasons</option>
            {Object.entries(REASON_LABELS).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="card" style={{ padding: 0, overflow: "hidden" }}>
        {loading ? (
          <div className="empty-state">Loading…</div>
        ) : filtered.length === 0 ? (
          <div className="empty-state">No missed entries.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Asset</th>
                <th>Side</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((item) => {
                const side = (item.rawPayload as { side?: string } | undefined)
                  ?.side;
                return (
                  <tr key={item.id}>
                    <td>{formatTimeET(item.timestamp)}</td>
                    <td>{ASSET_LABELS[item.asset] ?? item.asset}</td>
                    <td style={{ textTransform: "uppercase", color: sideColor(side) }}>
                      {side ?? "—"}
                    </td>
                    <td>
                      <span className="pill amber">
                        {REASON_LABELS[item.reason] ?? item.reason}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
