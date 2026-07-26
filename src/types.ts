export type Asset = "btc" | "tech" | "ai" | "china";
export type Side = "long" | "short";
export type PositionStatus = "open" | "closed";
export type TradingMode = "live" | "dry_run";

export const ASSET_LABELS: Record<Asset, string> = {
  btc: "BTC Nano Perp",
  tech: "Tech100",
  ai: "AI10",
  china: "China10",
};

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
  dailyLossKillSwitchPct: number;
  liveMode: boolean;
  tradingWindow: Record<Asset, AssetTradingWindow>;
  feesPerContract: Record<Asset, number>;
}

export interface Timestamped {
  seconds: number;
  nanoseconds: number;
}

export interface PositionDoc {
  asset: Asset;
  side: Side;
  size: number;
  contractSize: number;
  feePerContract: number;
  leverage: number;
  entryPrice: number;
  entryTime: Timestamped;
  exitPrice: number | null;
  exitTime: Timestamped | null;
  status: PositionStatus;
  mode: TradingMode;
  pnl: number | null;
  fee: number | null;
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
  timestamp: Timestamped;
  reason: MissedEntryReason;
  rawPayload: unknown;
}

export interface ErrorDoc {
  time: Timestamped;
  context: string;
  message: string;
}
