import { Asset } from "./admin";

export type Side = "long" | "short";
// "ignore" is sent by the real Pine scripts' internal TP/SL exit orders —
// those exist only so TradingView's own backtest visualization looks
// right; the actual TP/SL enforcement is Coinbase's exchange-side bracket
// order (live) or the simulated watcher (dry-run), never Pine. The server
// no-ops this action immediately rather than treating it as a real flatten.
export type WebhookAction = "entry" | "flatten" | "ignore";

export interface WebhookPayload {
  secret: string;
  asset: Asset;
  action: WebhookAction;
  side?: Side;
  tpDollars?: number;
  slDollars?: number;
}

export interface AssetTradingWindow {
  entryStartMins: number;
  entryCutoffMins: number;
  flattenMins: number;
  cooldownHours: number;
  weekendBlocked: boolean;
}

export interface SystemConfig {
  globalKillSwitch: boolean;
  assetKillSwitches: Record<Asset, boolean>;
  // Raw dollar amount — session PnL (realized trades today + unrealized
  // mark-to-market of whatever's currently open, fees netted in) breaching
  // this triggers the global kill switch. Stays on until manually cleared.
  sessionLossLimitDollars: number;
  liveMode: boolean;
  tradingWindow: Record<Asset, AssetTradingWindow>;
  // Round-trip commission per contract, in dollars — Coinbase futures charge
  // a flat per-contract fee rather than a percentage of notional.
  feesPerContract: Record<Asset, number>;
  // Manual cap on how much of the account any single strategy's entry sizes
  // against — every asset sizes off whichever is lower, this or Coinbase's
  // actual reported futures buying power, so growth in real buying power
  // never silently increases position size beyond what's been set here.
  tradableBalanceDollars: number;
}

export type PositionStatus = "open" | "closed";
export type TradingMode = "live" | "dry_run";

export interface PositionDoc {
  asset: Asset;
  side: Side;
  size: number;
  // Notional value of one contract in the underlying's own units (e.g. 0.01
  // BTC for the nano contract) — required to compute correct PnL, since
  // price moves apply per unit of underlying, not per contract.
  contractSize: number;
  // Round-trip fee per contract at entry time (a snapshot of
  // config.feesPerContract[asset] so later rate changes don't retroactively
  // alter already-closed positions' recorded economics).
  feePerContract: number;
  leverage: number;
  entryPrice: number;
  entryTime: FirebaseFirestore.Timestamp;
  exitPrice: number | null;
  exitTime: FirebaseFirestore.Timestamp | null;
  status: PositionStatus;
  mode: TradingMode;
  pnl: number | null;
  fee: number | null;
  // From the entry signal. In live mode these only informed the real
  // Coinbase bracket order placed at entry — Coinbase enforces TP/SL from
  // there, not this field. In dry-run mode there's no real bracket order,
  // so a scheduled watcher uses these to simulate the same behavior.
  tpDollars: number | null;
  slDollars: number | null;
  bracketOrderId: string | null;
  entryOrderId: string | null;
  // Whether the live Coinbase bracket order's TP has already been amended
  // down to the stale-position level (see staleTp.ts) — only ever set true
  // for live btc4h positions; meaningless (stays false) for everything else.
  staleAmended: boolean;
  // Buying power immediately before this entry — used by
  // liquidationWatcher.ts to detect once Coinbase's balance summary has
  // actually settled to reflect this position's margin usage (a fresh read
  // can lag behind the fill). Only meaningful for live positions; null for
  // dry-run.
  preEntryBuyingPower: number | null;
  // Whether the post-entry liquidation-safety check has resolved (verified
  // safe, or already flattened for being unsafe) — checked asynchronously by
  // liquidationWatcher.ts rather than blocking the webhook response, since
  // Coinbase's balance settlement time isn't bounded tightly enough to wait
  // on inline. Initialized true for anything the check doesn't apply to
  // (dry-run), so the watcher's query only ever picks up live positions
  // still genuinely awaiting a check.
  liquidationVerified: boolean;
}

export type MissedEntryReason =
  | "position_already_open"
  | "timing_restricted"
  | "kill_switch_active"
  | "daily_loss_limit"
  | "invalid_payload"
  | "market_session_closed";

export interface MissedEntryDoc {
  asset: Asset;
  timestamp: FirebaseFirestore.Timestamp;
  reason: MissedEntryReason;
  rawPayload: unknown;
}

export interface TradeDoc {
  positionId: string;
  asset: Asset;
  leg: "entry" | "exit";
  side: Side;
  size: number;
  price: number;
  time: FirebaseFirestore.Timestamp;
  mode: TradingMode;
  orderId: string | null;
  raw: unknown;
}

export interface DailyStatsDoc {
  balanceStart: number;
  realizedPnl: number;
  killSwitchTriggered: boolean;
}

export interface ErrorDoc {
  time: FirebaseFirestore.Timestamp;
  context: string;
  message: string;
  detail?: unknown;
}
