import { useEffect, useState } from "react";
import { useDoc, useCollection } from "../hooks";
import {
  setSessionLossLimit,
  setTradableBalance,
  setLiveMode,
  setTradingWindow,
  setFeePerContract,
  resetTradingWindowsToDefault,
  verifyCoinbaseAccess,
  listFuturesProducts,
  testLiveShortEntry,
  closeTestPosition,
} from "../api";
import type { Asset, AssetTradingWindow, PositionDoc, SystemConfig } from "../types";
import { ASSET_LABELS } from "../types";

const ASSETS: Asset[] = ["btc", "tech", "ai", "china", "btc4h"];

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

function FeeEditor({ asset, amount }: { asset: Asset; amount: number }) {
  const [draft, setDraft] = useState(amount);
  const [saving, setSaving] = useState(false);

  useEffect(() => setDraft(amount), [amount]);

  async function save() {
    setSaving(true);
    try {
      await setFeePerContract(asset, draft);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="settings-field" style={{ marginBottom: 0 }}>
      <label>{ASSET_LABELS[asset]} — round-trip $/contract</label>
      <div style={{ display: "flex", gap: 8 }}>
        <input
          type="number"
          step="0.1"
          min="0"
          value={draft}
          onChange={(e) => setDraft(Number(e.target.value))}
          style={{ width: 100 }}
        />
        <button className="settings-save" onClick={save} disabled={saving}>
          {saving ? "…" : "Save"}
        </button>
      </div>
    </div>
  );
}

export function SettingsPage() {
  const { data: config } = useDoc<SystemConfig>("system/config");
  const [lossLimit, setLossLimit] = useState<number | null>(null);
  const [savingPct, setSavingPct] = useState(false);
  const [tradableBalance, setTradableBalanceDraft] = useState<number | null>(null);
  const [savingTradableBalance, setSavingTradableBalance] = useState(false);
  const [verifyResult, setVerifyResult] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [productsResult, setProductsResult] = useState<string | null>(null);
  const [loadingProducts, setLoadingProducts] = useState(false);
  const [resetting, setResetting] = useState(false);
  const { items: allPositions } = useCollection<PositionDoc>("positions", []);
  const [testTradeBusy, setTestTradeBusy] = useState(false);
  const [testTradeError, setTestTradeError] = useState<string | null>(null);
  const openPosition = allPositions.find((p) => p.status === "open") ?? null;

  useEffect(() => {
    if (config && lossLimit === null) setLossLimit(config.sessionLossLimitDollars);
  }, [config, lossLimit]);

  useEffect(() => {
    if (config && tradableBalance === null) {
      setTradableBalanceDraft(config.tradableBalanceDollars);
    }
  }, [config, tradableBalance]);

  async function saveLossLimit() {
    if (lossLimit == null) return;
    setSavingPct(true);
    try {
      await setSessionLossLimit(lossLimit);
    } finally {
      setSavingPct(false);
    }
  }

  async function saveTradableBalance() {
    if (tradableBalance == null) return;
    setSavingTradableBalance(true);
    try {
      await setTradableBalance(tradableBalance);
    } finally {
      setSavingTradableBalance(false);
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
    if (!confirm("Reset all 5 trading windows back to the Pine script defaults?")) {
      return;
    }
    setResetting(true);
    try {
      await resetTradingWindowsToDefault();
    } finally {
      setResetting(false);
    }
  }

  async function enterTestTrade() {
    if (!window.confirm("Are u sure u want to enter?")) return;
    setTestTradeBusy(true);
    setTestTradeError(null);
    try {
      await testLiveShortEntry();
    } catch (err) {
      setTestTradeError(err instanceof Error ? err.message : String(err));
    } finally {
      setTestTradeBusy(false);
    }
  }

  async function closeTestTrade() {
    setTestTradeBusy(true);
    setTestTradeError(null);
    try {
      await closeTestPosition();
    } catch (err) {
      setTestTradeError(err instanceof Error ? err.message : String(err));
    } finally {
      setTestTradeBusy(false);
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

      <div className="grid grid-3" style={{ marginBottom: 16 }}>
        <div className="card">
          <div className="card-label">Session Loss Kill Switch</div>
          <div className="settings-field">
            <label>Trigger at $ session loss (realized + unrealized, fees included)</label>
            <input
              type="number"
              step="10"
              value={lossLimit ?? ""}
              onChange={(e) => setLossLimit(Number(e.target.value))}
            />
          </div>
          <button className="settings-save" onClick={saveLossLimit} disabled={savingPct}>
            {savingPct ? "Saving…" : "Save"}
          </button>
        </div>

        <div className="card">
          <div className="card-label">Tradable Balance Cap</div>
          <div className="settings-field">
            <label>
              Max $ of account any single entry sizes against — every
              strategy uses whichever is lower, this or Coinbase&apos;s actual
              reported futures buying power.
            </label>
            <input
              type="number"
              step="100"
              value={tradableBalance ?? ""}
              onChange={(e) => setTradableBalanceDraft(Number(e.target.value))}
            />
          </div>
          <button
            className="settings-save"
            onClick={saveTradableBalance}
            disabled={savingTradableBalance}
          >
            {savingTradableBalance ? "Saving…" : "Save"}
          </button>
        </div>

        <div className="card">
          <div className="card-label">Trading Mode</div>
          <div className="toggle-row" style={{ borderBottom: "none" }}>
            <span className="toggle-label">Live mode (real Coinbase orders)</span>
            <button
              className={`switch ${config?.liveMode ? "on" : ""}`}
              onClick={() => setLiveMode(!config?.liveMode)}
            />
          </div>
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

      <h3 style={{ margin: "24px 0 12px" }}>Fees</h3>
      <div className="card" style={{ marginBottom: 16 }}>
        <p style={{ fontSize: 13, color: "var(--text-dim)", margin: "0 0 14px" }}>
          Round-trip commission per contract, charged once per position.
          Changing a rate only affects positions entered afterward — already
          closed positions keep the rate that was in effect when they opened.
        </p>
        <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
          {config &&
            ASSETS.map((asset) => (
              <FeeEditor
                key={asset}
                asset={asset}
                amount={config.feesPerContract[asset]}
              />
            ))}
        </div>
      </div>

      <div className="card" style={{ marginTop: 24 }}>
        <div className="card-label">Coinbase Access Check</div>
        <p style={{ fontSize: 13, color: "var(--text-dim)", margin: "0 0 12px" }}>
          Confirms the Coinbase API key can read futures balance and all 5
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

      <div className="card" style={{ marginTop: 16, marginBottom: 24 }}>
        <div className="card-label">Test Live Trade</div>
        <p style={{ fontSize: 13, color: "var(--text-dim)", margin: "0 0 12px" }}>
          Places one real short contract on BTC Nano Perp (0.01 BTC notional)
          directly on Coinbase — real money, independent of the dry-run
          toggle and bypassing kill switches and trading-window checks. No
          take-profit/stop-loss is attached; use Close Position to exit.
        </p>
        {openPosition ? (
          <button
            className="settings-save"
            style={{ background: "var(--red)" }}
            onClick={closeTestTrade}
            disabled={testTradeBusy}
          >
            {testTradeBusy
              ? "Closing…"
              : `Close Position (${ASSET_LABELS[openPosition.asset]} ${openPosition.side.toUpperCase()})`}
          </button>
        ) : (
          <button
            className="settings-save"
            style={{ background: "var(--red)" }}
            onClick={enterTestTrade}
            disabled={testTradeBusy}
          >
            {testTradeBusy ? "Placing…" : "Place Test Short — 1 Contract BTC (LIVE)"}
          </button>
        )}
        {testTradeError && (
          <div style={{ color: "var(--red)", fontSize: 13, marginTop: 10 }}>
            {testTradeError}
          </div>
        )}
      </div>
    </div>
  );
}
