import { Asset } from "./admin";

export type Side = "long" | "short";
export type WebhookAction = "entry" | "flatten";

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
  dailyLossKillSwitchPct: number;
  liveMode: boolean;
  tradingWindow: Record<Asset, AssetTradingWindow>;
}

export type PositionStatus = "open" | "closed";
export type TradingMode = "live" | "dry_run";

export interface PositionDoc {
  asset: Asset;
  side: Side;
  size: number;
  leverage: number;
  entryPrice: number;
  entryTime: FirebaseFirestore.Timestamp;
  exitPrice: number | null;
  exitTime: FirebaseFirestore.Timestamp | null;
  status: PositionStatus;
  mode: TradingMode;
  pnl: number | null;
  bracketOrderId: string | null;
  entryOrderId: string | null;
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
