import { useEffect, useState } from "react";
import { orderBy, useCollection, useDoc } from "../hooks";
import { setKillSwitch, getSystemState, type SystemState } from "../api";
import type {
  Asset,
  ErrorDoc,
  PositionDoc,
  SystemConfig,
} from "../types";
import { ASSET_LABELS } from "../types";
import { minsUntilFlatten, windowStatus, dateStringET } from "../timeUtils";
import { pnlColor, pnlSign, sideColor } from "../format";

const ASSETS: Asset[] = ["btc", "tech", "ai", "china"];

function Toggle({
  on,
  danger,
  lg,
  onClick,
}: {
  on: boolean;
  danger?: boolean;
  lg?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className={`switch ${danger ? "" : "accent"} ${lg ? "switch-lg" : ""} ${on ? "on" : ""}`}
      onClick={onClick}
      aria-pressed={on}
    />
  );
}

export function OverviewPage() {
  const { data: config } = useDoc<SystemConfig>("system/config");
  const { items: openPositions } = useCollection<PositionDoc>("positions", [
    // client-side filter below; Firestore composite index not required for a single equality
  ]);
  const { items: recentErrors } = useCollection<ErrorDoc>("errors", [
    orderBy("time", "desc"),
  ]);
  const [busy, setBusy] = useState<string | null>(null);
  const [systemState, setSystemState] = useState<SystemState | null>(null);

  // Ticks once a second so the session timer's seconds actually count down
  // live instead of being frozen at whatever second the page last rendered.
  const [, setClockTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setClockTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  // Balance and market-session status both require live Coinbase calls, so
  // they're polled on a slow interval rather than every second.
  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const result = await getSystemState();
        if (!cancelled) setSystemState(result.data);
      } catch {
        // Keep showing the last known state rather than clearing it.
      }
    }
    poll();
    const id = setInterval(poll, 30000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const openPosition = openPositions.find((p) => p.status === "open") ?? null;
  const lastErrors = recentErrors.slice(0, 3);

  // Today's profit = realized PnL of positions closed today (ET) + the
  // currently open position's unrealized PnL, with its round-trip fee
  // already subtracted even though only the entry leg has technically
  // happened — it's a certain cost, not a hypothetical one.
  const todayStr = dateStringET(new Date());
  const realizedToday = openPositions
    .filter(
      (p) =>
        p.status === "closed" &&
        p.exitTime &&
        dateStringET(new Date(p.exitTime.seconds * 1000)) === todayStr &&
        p.pnl != null
    )
    .reduce((sum, p) => sum + (p.pnl ?? 0), 0);

  let unrealizedOpen = 0;
  if (openPosition && systemState?.markPrice != null) {
    const priceDiff =
      openPosition.side === "long"
        ? systemState.markPrice - openPosition.entryPrice
        : openPosition.entryPrice - systemState.markPrice;
    const grossUnrealized =
      priceDiff * openPosition.size * openPosition.contractSize;
    const fee = openPosition.feePerContract * openPosition.size;
    unrealizedOpen = grossUnrealized - fee;
  }

  const todaysProfit = realizedToday + unrealizedOpen;

  async function toggleGlobal() {
    if (!config) return;
    setBusy("global");
    try {
      await setKillSwitch("global", !config.globalKillSwitch);
    } finally {
      setBusy(null);
    }
  }

  async function toggleAsset(asset: Asset) {
    if (!config) return;
    setBusy(asset);
    try {
      await setKillSwitch(asset, !config.assetKillSwitches[asset]);
    } finally {
      setBusy(null);
    }
  }

  // Priority order when multiple blocking reasons apply at once: kill
  // switch first (most severe/systemic), then weekend blocked, then
  // outside entry window (both handled internally by windowStatus, which
  // already checks weekend before window), then market-session-closed last.
  function pillFor(asset: Asset) {
    if (!config) return { isOpen: false, label: "loading…" };
    if (config.globalKillSwitch || config.assetKillSwitches[asset]) {
      return { isOpen: false, label: "kill switch active" };
    }
    const windowResult = windowStatus(config.tradingWindow[asset]);
    if (!windowResult.isOpen) {
      return windowResult;
    }
    if (systemState?.sessionOpen && systemState.sessionOpen[asset] === false) {
      return { isOpen: false, label: "market session closed" };
    }
    return windowResult;
  }

  return (
    <div>
      <h2 className="page-title">Overview</h2>

      {lastErrors.length > 0 && (
        <div className="banner">
          {lastErrors.length} recent error{lastErrors.length > 1 ? "s" : ""} —
          latest: {lastErrors[0].context}: {lastErrors[0].message}
        </div>
      )}

      <div className="grid grid-3" style={{ marginBottom: 16 }}>
        <div className="card">
          <div className="card-label">Current Position</div>
          {openPosition ? (
            <>
              <div className="card-value">
                {ASSET_LABELS[openPosition.asset]} ·{" "}
                <span style={{ color: sideColor(openPosition.side) }}>
                  {openPosition.side.toUpperCase()}
                </span>
              </div>
              <div style={{ color: "var(--text-dim)", fontSize: 13, marginTop: 6 }}>
                {openPosition.size} contracts @ {openPosition.entryPrice}
                {" · "}
                {openPosition.mode === "live" ? "live" : "dry-run"}
              </div>
            </>
          ) : (
            <div className="card-value" style={{ color: "var(--text)" }}>
              Flat
            </div>
          )}
        </div>

        <div className="card">
          <div className="card-label">Today's Profit</div>
          <div className="card-value" style={{ color: pnlColor(todaysProfit) }}>
            {pnlSign(todaysProfit)}
            {todaysProfit.toFixed(2)}
          </div>
          {openPosition && systemState?.markPrice == null && (
            <div style={{ color: "var(--text-faint)", fontSize: 12, marginTop: 6 }}>
              open position pending mark price…
            </div>
          )}
        </div>

        <div className="card">
          <div className="card-label">Account Balance</div>
          {systemState?.balance ? (
            <div className="card-value">
              ${systemState.balance.totalUsdBalance.toFixed(2)}
            </div>
          ) : (
            <div className="card-value" style={{ color: "var(--text-faint)" }}>
              Loading…
            </div>
          )}
        </div>
      </div>

      <div className="card session-timer-card" style={{ marginBottom: 16 }}>
        <div className="card-label session-timer-label">Session Timer</div>
        {openPosition ? (
          <div className="session-timer-value">
            Flattens in {minsUntilFlatten(config?.tradingWindow[openPosition.asset] ?? DEFAULT_WINDOW)}
          </div>
        ) : (
          <div className="grid grid-4" style={{ marginTop: 16 }}>
            {ASSETS.map((asset) => {
              const status = pillFor(asset);
              return (
                <div key={asset}>
                  <div style={{ fontSize: 15, color: "var(--text-dim)" }}>
                    {ASSET_LABELS[asset]}
                  </div>
                  <div
                    className={`pill ${status.isOpen ? "green" : "red"} pill-lg`}
                    style={{ marginTop: 6 }}
                  >
                    {status.label}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-label">Kill Switches</div>
        <div className="toggle-row">
          <span className="toggle-label toggle-label-lg">
            Global — stop all entries &amp; force-close
          </span>
          <Toggle
            on={!!config?.globalKillSwitch}
            danger
            lg
            onClick={toggleGlobal}
          />
        </div>
        {ASSETS.map((asset) => (
          <div className="toggle-row" key={asset}>
            <span className="toggle-label toggle-label-lg">{ASSET_LABELS[asset]}</span>
            <Toggle
              on={!!config?.assetKillSwitches[asset]}
              danger
              lg
              onClick={() => toggleAsset(asset)}
            />
          </div>
        ))}
        {busy && ASSETS.includes(busy as Asset) && (
          <div style={{ fontSize: 12, color: "var(--text-faint)", marginTop: 6 }}>
            Updating…
          </div>
        )}
      </div>
    </div>
  );
}

const DEFAULT_WINDOW = {
  entryStartMins: 0,
  entryCutoffMins: 810,
  flattenMins: 930,
  cooldownHours: 4,
  weekendBlocked: true,
};
