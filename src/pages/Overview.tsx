import { useState } from "react";
import { orderBy, useCollection, useDoc } from "../hooks";
import { setKillSwitch, setLiveMode } from "../api";
import type {
  Asset,
  ErrorDoc,
  PositionDoc,
  SystemConfig,
} from "../types";
import { ASSET_LABELS } from "../types";
import { minsUntilFlatten, windowStatus } from "../timeUtils";

const ASSETS: Asset[] = ["btc", "tech", "ai", "china"];

function Toggle({
  on,
  danger,
  onClick,
}: {
  on: boolean;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className={`switch ${danger ? "" : "accent"} ${on ? "on" : ""}`}
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

  const openPosition = openPositions.find((p) => p.status === "open") ?? null;
  const lastErrors = recentErrors.slice(0, 3);

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

  async function toggleLiveMode() {
    if (!config) return;
    setBusy("liveMode");
    try {
      await setLiveMode(!config.liveMode);
    } finally {
      setBusy(null);
    }
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

      <div className="grid grid-2" style={{ marginBottom: 16 }}>
        <div className="card">
          <div className="card-label">Current Position</div>
          {openPosition ? (
            <>
              <div className="card-value">
                {ASSET_LABELS[openPosition.asset]} · {openPosition.side.toUpperCase()}
              </div>
              <div style={{ color: "var(--text-dim)", fontSize: 13, marginTop: 6 }}>
                {openPosition.size} contracts @ {openPosition.entryPrice}
                {" · "}
                {openPosition.mode === "live" ? "live" : "dry-run"}
              </div>
            </>
          ) : (
            <div className="card-value" style={{ color: "var(--text-faint)" }}>
              Flat
            </div>
          )}
        </div>

        <div className="card">
          <div className="card-label">Trading Mode</div>
          <div className="toggle-row" style={{ borderBottom: "none", padding: "4px 0" }}>
            <span className="toggle-label">
              {config?.liveMode ? "Live — real orders" : "Dry run — simulated"}
            </span>
            <Toggle
              on={!!config?.liveMode}
              onClick={toggleLiveMode}
            />
          </div>
          {busy === "liveMode" && (
            <div style={{ fontSize: 12, color: "var(--text-faint)" }}>Updating…</div>
          )}
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-label">Session Timer</div>
        {openPosition ? (
          <div className="card-value">
            Flattens in {minsUntilFlatten(config?.tradingWindow[openPosition.asset] ?? DEFAULT_WINDOW)}
          </div>
        ) : (
          <div className="grid grid-4" style={{ marginTop: 10 }}>
            {ASSETS.map((asset) => {
              const window = config?.tradingWindow[asset];
              if (!window) return null;
              const status = windowStatus(window);
              return (
                <div key={asset}>
                  <div style={{ fontSize: 12, color: "var(--text-dim)" }}>
                    {ASSET_LABELS[asset]}
                  </div>
                  <div
                    className={`pill ${status.isOpen ? "green" : "neutral"}`}
                    style={{ marginTop: 4 }}
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
          <span className="toggle-label">Global — stop all entries &amp; force-close</span>
          <Toggle
            on={!!config?.globalKillSwitch}
            danger
            onClick={toggleGlobal}
          />
        </div>
        {ASSETS.map((asset) => (
          <div className="toggle-row" key={asset}>
            <span className="toggle-label">{ASSET_LABELS[asset]}</span>
            <Toggle
              on={!!config?.assetKillSwitches[asset]}
              danger
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
