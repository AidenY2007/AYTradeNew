import { useEffect, useState } from "react";
import { useDoc } from "../hooks";
import {
  setDailyLossPct,
  setLiveMode,
  setTradingWindow,
  resetTradingWindowsToDefault,
  verifyCoinbaseAccess,
  listFuturesProducts,
} from "../api";
import type { Asset, AssetTradingWindow, SystemConfig } from "../types";
import { ASSET_LABELS } from "../types";

const ASSETS: Asset[] = ["btc", "tech", "ai", "china"];

function minsToHHMM(mins: number): string {
  const h = Math.floor(mins / 60).toString().padStart(2, "0");
  const m = (mins % 60).toString().padStart(2, "0");
  return `${h}:${m}`;
}

function hhmmToMins(value: string): number {
  const [h, m] = value.split(":").map(Number);
  return h * 60 + m;
}

function WindowEditor({
  asset,
  window,
}: {
  asset: Asset;
  window: AssetTradingWindow;
}) {
  const [draft, setDraft] = useState(window);
  const [saving, setSaving] = useState(false);

  useEffect(() => setDraft(window), [window]);

  async function save() {
    setSaving(true);
    try {
      await setTradingWindow(asset, draft);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <div className="card-label">{ASSET_LABELS[asset]}</div>
      <div style={{ display: "flex", gap: 20, flexWrap: "wrap" }}>
        <div className="settings-field">
          <label>Entry window start (ET)</label>
          <input
            type="time"
            value={minsToHHMM(draft.entryStartMins)}
            onChange={(e) =>
              setDraft({ ...draft, entryStartMins: hhmmToMins(e.target.value) })
            }
          />
        </div>
        <div className="settings-field">
          <label>Entry cutoff (ET)</label>
          <input
            type="time"
            value={minsToHHMM(draft.entryCutoffMins)}
            onChange={(e) =>
              setDraft({ ...draft, entryCutoffMins: hhmmToMins(e.target.value) })
            }
          />
        </div>
        <div className="settings-field">
          <label>Daily flatten (ET)</label>
          <input
            type="time"
            value={minsToHHMM(draft.flattenMins)}
            onChange={(e) =>
              setDraft({ ...draft, flattenMins: hhmmToMins(e.target.value) })
            }
          />
        </div>
        <div className="settings-field">
          <label>Cooldown after exit (hours)</label>
          <input
            type="number"
            step="0.5"
            value={draft.cooldownHours}
            onChange={(e) =>
              setDraft({ ...draft, cooldownHours: Number(e.target.value) })
            }
          />
        </div>
      </div>
      <div className="toggle-row" style={{ borderBottom: "none", paddingTop: 4 }}>
        <span className="toggle-label">Block weekend entries</span>
        <button
          className={`switch ${draft.weekendBlocked ? "on" : ""}`}
          onClick={() => setDraft({ ...draft, weekendBlocked: !draft.weekendBlocked })}
        />
      </div>
      <button className="settings-save" onClick={save} disabled={saving}>
        {saving ? "Saving…" : "Save"}
      </button>
    </div>
  );
}

export function SettingsPage() {
  const { data: config } = useDoc<SystemConfig>("system/config");
  const [lossPct, setLossPct] = useState<number | null>(null);
  const [savingPct, setSavingPct] = useState(false);
  const [verifyResult, setVerifyResult] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [productsResult, setProductsResult] = useState<string | null>(null);
  const [loadingProducts, setLoadingProducts] = useState(false);
  const [resetting, setResetting] = useState(false);

  useEffect(() => {
    if (config && lossPct === null) setLossPct(config.dailyLossKillSwitchPct);
  }, [config, lossPct]);

  async function saveLossPct() {
    if (lossPct == null) return;
    setSavingPct(true);
    try {
      await setDailyLossPct(lossPct);
    } finally {
      setSavingPct(false);
    }
  }

  async function runVerify() {
    setVerifying(true);
    setVerifyResult(null);
    try {
      const result = await verifyCoinbaseAccess();
      setVerifyResult(JSON.stringify(result.data, null, 2));
    } catch (err) {
      setVerifyResult(err instanceof Error ? err.message : String(err));
    } finally {
      setVerifying(false);
    }
  }

  async function resetWindows() {
    if (!confirm("Reset all 4 trading windows back to the Pine script defaults?")) {
      return;
    }
    setResetting(true);
    try {
      await resetTradingWindowsToDefault();
    } finally {
      setResetting(false);
    }
  }

  async function runListProducts() {
    setLoadingProducts(true);
    setProductsResult(null);
    try {
      const result = await listFuturesProducts();
      setProductsResult(JSON.stringify(result.data, null, 2));
    } catch (err) {
      setProductsResult(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingProducts(false);
    }
  }

  return (
    <div>
      <h2 className="page-title">Settings</h2>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-label">Daily Loss Kill Switch</div>
        <div className="settings-field">
          <label>Trigger at % of account balance lost in a day</label>
          <input
            type="number"
            step="1"
            value={lossPct ?? ""}
            onChange={(e) => setLossPct(Number(e.target.value))}
          />
        </div>
        <button className="settings-save" onClick={saveLossPct} disabled={savingPct}>
          {savingPct ? "Saving…" : "Save"}
        </button>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="toggle-row" style={{ borderBottom: "none" }}>
          <span className="toggle-label">Live mode (real Coinbase orders)</span>
          <button
            className={`switch ${config?.liveMode ? "on" : ""}`}
            onClick={() => setLiveMode(!config?.liveMode)}
          />
        </div>
      </div>

      <div className="section-header" style={{ margin: "24px 0 12px" }}>
        <h3 style={{ margin: 0 }}>Trading Windows</h3>
        <button className="settings-save" onClick={resetWindows} disabled={resetting}>
          {resetting ? "Resetting…" : "Reset all to Pine defaults"}
        </button>
      </div>
      {config &&
        ASSETS.map((asset) => (
          <WindowEditor key={asset} asset={asset} window={config.tradingWindow[asset]} />
        ))}

      <div className="card" style={{ marginTop: 24 }}>
        <div className="card-label">Coinbase Access Check</div>
        <p style={{ fontSize: 13, color: "var(--text-dim)", margin: "0 0 12px" }}>
          Confirms the Coinbase API key can read futures balance and all 4
          product definitions before going live.
        </p>
        <button className="settings-save" onClick={runVerify} disabled={verifying}>
          {verifying ? "Checking…" : "Run check"}
        </button>
        {verifyResult && (
          <pre
            style={{
              marginTop: 12,
              padding: 12,
              background: "var(--bg-elevated)",
              borderRadius: 8,
              fontSize: 11.5,
              overflowX: "auto",
              maxHeight: 300,
            }}
          >
            {verifyResult}
          </pre>
        )}
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div className="card-label">List Futures Products</div>
        <p style={{ fontSize: 13, color: "var(--text-dim)", margin: "0 0 12px" }}>
          One-off lookup of the exact product_id strings Coinbase uses for
          your futures products, so PRODUCT_IDS can be corrected.
        </p>
        <button className="settings-save" onClick={runListProducts} disabled={loadingProducts}>
          {loadingProducts ? "Loading…" : "List products"}
        </button>
        {productsResult && (
          <pre
            style={{
              marginTop: 12,
              padding: 12,
              background: "var(--bg-elevated)",
              borderRadius: 8,
              fontSize: 11.5,
              overflowX: "auto",
              maxHeight: 300,
            }}
          >
            {productsResult}
          </pre>
        )}
      </div>
    </div>
  );
}
