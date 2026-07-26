import { orderBy, useCollection } from "../hooks";
import type { MissedEntryDoc } from "../types";
import { ASSET_LABELS } from "../types";
import { formatTimeET } from "../format";

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

  return (
    <div>
      <h2 className="page-title">Missed Entries</h2>
      <div className="card" style={{ padding: 0, overflow: "hidden" }}>
        {loading ? (
          <div className="empty-state">Loading…</div>
        ) : items.length === 0 ? (
          <div className="empty-state">No missed entries.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Asset</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td>{formatTimeET(item.timestamp)}</td>
                  <td>{ASSET_LABELS[item.asset] ?? item.asset}</td>
                  <td>
                    <span className="pill amber">
                      {REASON_LABELS[item.reason] ?? item.reason}
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
