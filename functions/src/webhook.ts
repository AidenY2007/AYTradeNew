import * as crypto from "crypto";
import { onRequest } from "firebase-functions/https";
import * as logger from "firebase-functions/logger";
import { Timestamp } from "firebase-admin/firestore";
import { db, ASSETS, Asset } from "./admin";
import {
  coinbaseApiKeyName,
  coinbaseApiPrivateKey,
  webhookSharedSecret,
} from "./secrets";
import { getConfig } from "./config";
import { checkEntryAllowed, isFridayMaintenanceWindow } from "./tradingWindow";
import {
  PRODUCT_IDS,
  getBalanceSummary,
  getProduct,
  maxLeverageForSide,
  maxOvernightLeverageForSide,
  placeMarketOrder,
  waitForFill,
} from "./coinbase/client";
import { computeMaxContractsSize } from "./sizing";
import { closeOpenPosition, placeBracketWithFailsafe } from "./positionActions";
import { acquireActionLock, releaseActionLock } from "./lock";
import {
  WebhookPayload,
  MissedEntryReason,
  PositionDoc,
  TradeDoc,
  TradeLogDoc,
  WebhookAction,
} from "./types";

const positionsCol = db.collection("positions");
const tradesCol = db.collection("trades");
const missedEntriesCol = db.collection("missedEntries");
const errorsCol = db.collection("errors");
const tradeLogsCol = db.collection("tradeLogs");

// Mutable accumulator threaded through the whole request: every handler
// below fills in whichever section it touches (config, balance, product,
// sizing, order) as it goes, so the single doc written at the very end
// captures the complete picture regardless of where the request stopped —
// blocked early, blocked late, succeeded, or threw.
type TradeLogDraft = Omit<TradeLogDoc, "time" | "action"> & {
  time: Timestamp;
  action: WebhookAction | null;
};

// Called only once payload.action/asset are already validated as real
// "entry"/"flatten" + a known Asset — see the invalid-payload check above
// the call site.
function newTradeLogDraft(asset: Asset, payload: Partial<WebhookPayload>): TradeLogDraft {
  const rest = { ...payload };
  delete rest.secret;
  return {
    requestId: crypto.randomUUID(),
    time: Timestamp.now(),
    asset,
    action: (payload.action as WebhookAction) ?? null,
    outcome: "unknown",
    positionId: null,
    payload: rest,
    config: null,
    balance: null,
    product: null,
    sizing: null,
    order: null,
    error: null,
  };
}

async function writeTradeLog(draft: TradeLogDraft): Promise<void> {
  try {
    await tradeLogsCol.add(draft);
  } catch (err) {
    // Never let a logging failure mask the real outcome already sent to
    // TradingView — this collection is purely diagnostic.
    logger.error("Failed to write trade log", err);
  }
}

function secretsMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

async function logMissedEntry(
  asset: Asset,
  reason: MissedEntryReason,
  rawPayload: unknown
) {
  await missedEntriesCol.add({
    asset,
    timestamp: Timestamp.now(),
    reason,
    rawPayload,
  });
}

async function logError(context: string, err: unknown) {
  logger.error(context, err);
  await errorsCol.add({
    time: Timestamp.now(),
    context,
    message: err instanceof Error ? err.message : String(err),
  });
}

async function getOpenPosition() {
  const snap = await positionsCol
    .where("status", "==", "open")
    .limit(1)
    .get();
  return snap.empty ? null : { id: snap.docs[0].id, data: snap.docs[0].data() as PositionDoc };
}

async function getLastExitTime(asset: Asset): Promise<Date | null> {
  const snap = await positionsCol
    .where("asset", "==", asset)
    .where("status", "==", "closed")
    .orderBy("exitTime", "desc")
    .limit(1)
    .get();
  if (snap.empty) return null;
  const exitTime = snap.docs[0].data().exitTime as Timestamp | null;
  return exitTime ? exitTime.toDate() : null;
}

async function getTodaysDailyStats() {
  const key = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
  }).format(new Date()); // yyyy-mm-dd
  const ref = db.collection("dailyStats").doc(key);
  const snap = await ref.get();
  return { ref, data: snap.exists ? snap.data() : null };
}

export const webhook = onRequest(
  {
    secrets: [coinbaseApiKeyName, coinbaseApiPrivateKey, webhookSharedSecret],
    // TradingView times a webhook delivery out well before a cold-started
    // Cloud Run instance can spin up (container init + secret injection +
    // module load), which is most likely to bite after a long idle gap —
    // e.g. the trading window being closed for hours. Keeping one instance
    // always warm removes that cold-start latency entirely.
    minInstances: 1,
  },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).send("Method not allowed");
      return;
    }

    // TradingView sends alert webhook bodies as Content-Type: text/plain,
    // so Firebase's automatic JSON body-parsing (which only triggers for
    // application/json) never runs — req.body arrives empty. Fall back to
    // parsing the raw body ourselves.
    let payload: Partial<WebhookPayload> | undefined;
    if (req.body && typeof req.body === "object" && Object.keys(req.body).length > 0) {
      payload = req.body as Partial<WebhookPayload>;
    } else if (req.rawBody) {
      try {
        payload = JSON.parse(req.rawBody.toString("utf8"));
      } catch (err) {
        logger.warn("Webhook body failed to parse as JSON", err);
      }
    }

    if (!payload || typeof payload.secret !== "string") {
      res.status(400).send("Bad request");
      return;
    }
    if (!secretsMatch(payload.secret, webhookSharedSecret.value())) {
      logger.warn("Webhook received with invalid secret");
      res.status(401).send("Unauthorized");
      return;
    }

    // Pine's own strategy.exit() TP/SL orders fire this on every bar-close
    // fill purely so TradingView's backtest visualization stays accurate —
    // Coinbase's real bracket order (or the dry-run watcher) is the actual
    // enforcement, so this is a pure no-op, checked before any Firestore or
    // Coinbase call to keep it as cheap and fast as possible.
    if (payload.action === "ignore") {
      res.status(200).send("ignored");
      return;
    }

    // Pine sends the asset code uppercase ("BTC"), but our internal Asset
    // type/ASSETS list is lowercase ("btc") — normalize before validating,
    // otherwise every real signal fails this check silently.
    if (typeof payload.asset === "string") {
      payload.asset = payload.asset.toLowerCase() as Asset;
    }

    if (
      !payload.asset ||
      !ASSETS.includes(payload.asset) ||
      (payload.action !== "entry" && payload.action !== "flatten")
    ) {
      await logMissedEntry(
        (payload.asset as Asset) ?? "btc",
        "invalid_payload",
        payload
      );
      res.status(400).send("Invalid payload");
      return;
    }

    const asset = payload.asset;
    const creds = {
      apiKeyName: coinbaseApiKeyName.value(),
      privateKeyPem: coinbaseApiPrivateKey.value(),
    };

    const logDraft = newTradeLogDraft(asset, payload);
    try {
      const config = await getConfig();

      const outcome =
        payload.action === "entry"
          ? await handleEntry(asset, payload, config, creds, logDraft)
          : await handleFlatten(asset, config, creds, logDraft);
      logDraft.outcome = outcome;
      res.status(200).send(outcome);
    } catch (err) {
      logDraft.outcome = "error";
      logDraft.error = {
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack ?? null : null,
      };
      await logError(`webhook:${payload.action}:${asset}`, err);
      res.status(500).send("error");
    } finally {
      await writeTradeLog(logDraft);
    }
  }
);

async function handleEntry(
  asset: Asset,
  payload: Partial<WebhookPayload>,
  config: Awaited<ReturnType<typeof getConfig>>,
  creds: { apiKeyName: string; privateKeyPem: string },
  logDraft: TradeLogDraft
): Promise<string> {
  logDraft.config = {
    liveMode: config.liveMode,
    globalKillSwitch: config.globalKillSwitch,
    assetKillSwitch: config.assetKillSwitches[asset],
    sessionLossLimitDollars: config.sessionLossLimitDollars,
    tradableBalanceDollars: config.tradableBalanceDollars,
  };

  if (config.globalKillSwitch) {
    await logMissedEntry(asset, "kill_switch_active", payload);
    return "blocked:kill_switch_active";
  }
  if (config.assetKillSwitches[asset]) {
    await logMissedEntry(asset, "kill_switch_active", payload);
    return "blocked:kill_switch_active";
  }

  const acquired = await acquireActionLock();
  if (!acquired) {
    await logMissedEntry(asset, "position_already_open", payload);
    return "blocked:position_already_open";
  }
  try {
    return await handleEntryLocked(asset, payload, config, creds, logDraft);
  } finally {
    await releaseActionLock();
  }
}

async function handleEntryLocked(
  asset: Asset,
  payload: Partial<WebhookPayload>,
  config: Awaited<ReturnType<typeof getConfig>>,
  creds: { apiKeyName: string; privateKeyPem: string },
  logDraft: TradeLogDraft
): Promise<string> {
  const { data: dailyStats } = await getTodaysDailyStats();
  if (dailyStats?.killSwitchTriggered) {
    await logMissedEntry(asset, "daily_loss_limit", payload);
    return "blocked:daily_loss_limit";
  }

  const openPosition = await getOpenPosition();
  if (openPosition) {
    await logMissedEntry(asset, "position_already_open", payload);
    return "blocked:position_already_open";
  }

  const window = config.tradingWindow[asset];
  const lastExitTime = await getLastExitTime(asset);
  const windowCheck = checkEntryAllowed(window, lastExitTime);
  if (!windowCheck.ok) {
    await logMissedEntry(asset, "timing_restricted", {
      ...payload,
      windowReason: windowCheck.reason,
    });
    return `blocked:timing_restricted:${windowCheck.reason}`;
  }

  // btc4h is otherwise always allowed to enter (it holds through nights and
  // weekends), except during Coinbase's Friday maintenance window.
  if (asset === "btc4h" && isFridayMaintenanceWindow()) {
    await logMissedEntry(asset, "timing_restricted", {
      ...payload,
      windowReason: "coinbase_maintenance",
    });
    return "blocked:timing_restricted:coinbase_maintenance";
  }

  if (!payload.side || (payload.side !== "long" && payload.side !== "short")) {
    await logMissedEntry(asset, "invalid_payload", payload);
    return "blocked:invalid_payload";
  }

  const productId = PRODUCT_IDS[asset];
  const mode = config.liveMode ? "live" : "dry_run";

  const [balanceSummary, product] = await Promise.all([
    getBalanceSummary(creds),
    getProduct(creds, asset),
  ]);

  logDraft.balance = {
    futuresBuyingPower: balanceSummary.futuresBuyingPower,
    totalUsdBalance: balanceSummary.totalUsdBalance,
    overnightLiquidationBufferUsd: balanceSummary.overnightLiquidationBufferUsd,
  };
  logDraft.product = {
    price: product.price,
    baseIncrement: product.baseIncrement,
    intradayLongMarginRate: product.intradayLongMarginRate,
    intradayShortMarginRate: product.intradayShortMarginRate,
    overnightLongMarginRate: product.overnightLongMarginRate,
    overnightShortMarginRate: product.overnightShortMarginRate,
    isSessionOpen: product.isSessionOpen,
  };

  // Tech/AI/China follow real equity-index market hours, unlike BTC's
  // 24/7 session — this is separate from (and in addition to) our own
  // Pine-mirrored timing rules. btc4h skips this: it already has its own
  // hardcoded maintenance-window check above rather than trusting Coinbase's
  // live session-status field for that purpose.
  if (asset !== "btc4h" && !product.isSessionOpen) {
    await logMissedEntry(asset, "market_session_closed", payload);
    return "blocked:market_session_closed";
  }

  // Sizes off whichever is lower — Coinbase's real buying power, or the
  // manual cap — so growth in real account balance never silently increases
  // position size beyond what's been configured in Settings.
  const balance = Math.min(
    balanceSummary.futuresBuyingPower,
    config.tradableBalanceDollars
  );
  const leverage =
    asset === "btc4h"
      ? maxOvernightLeverageForSide(product, payload.side)
      : maxLeverageForSide(product, payload.side);
  const size = computeMaxContractsSize(
    balance,
    product.price,
    leverage,
    product.baseIncrement,
    product.contractSize
  );

  logDraft.sizing = { balanceUsed: balance, leverage, size: Number(size) };

  if (Number(size) <= 0) {
    await logError(
      `webhook:entry:${asset}`,
      new Error(`Computed size <= 0 (balance=${balance}, price=${product.price})`)
    );
    return "blocked:zero_size";
  }

  const orderSide = payload.side === "long" ? "BUY" : "SELL";
  const closingSide = payload.side === "long" ? "SELL" : "BUY";

  let entryOrderId: string | null = null;
  let entryPrice = product.price;
  let bracketOrderId: string | null = null;

  const tpDollars = payload.tpDollars ?? 0;
  const slDollars = payload.slDollars ?? 0;
  let tpPrice =
    payload.side === "long" ? entryPrice + tpDollars : entryPrice - tpDollars;
  let slPrice =
    payload.side === "long" ? entryPrice - slDollars : entryPrice + slDollars;

  if (config.liveMode) {
    const entryOrder = await placeMarketOrder(creds, productId, orderSide, size);
    entryOrderId = entryOrder.orderId;

    const fill = await waitForFill(creds, entryOrder.orderId);
    entryPrice = fill.avgFilledPrice ?? product.price;

    // Recompute off the real fill price, not the pre-fill quote used above.
    tpPrice = payload.side === "long" ? entryPrice + tpDollars : entryPrice - tpDollars;
    slPrice = payload.side === "long" ? entryPrice - slDollars : entryPrice + slDollars;

    bracketOrderId = await placeBracketWithFailsafe(
      creds,
      productId,
      closingSide,
      size,
      tpPrice,
      slPrice,
      product.quoteIncrement,
      entryOrderId,
      entryPrice
    );
  }

  logDraft.order = {
    entryOrderId,
    entryPrice,
    bracketOrderId,
    tpPrice,
    slPrice,
    exitOrderId: null,
    exitPrice: null,
  };

  const positionDoc: PositionDoc = {
    asset,
    side: payload.side,
    size: Number(size),
    contractSize: product.contractSize,
    feePerContract: config.feesPerContract[asset],
    leverage,
    entryPrice,
    entryTime: Timestamp.now(),
    exitPrice: null,
    exitTime: null,
    status: "open",
    mode,
    pnl: null,
    fee: null,
    tpDollars: payload.tpDollars ?? null,
    slDollars: payload.slDollars ?? null,
    bracketOrderId,
    entryOrderId,
    // The liquidation-safety check runs asynchronously now (see
    // liquidationWatcher.ts) rather than blocking this response — Coinbase's
    // balance-settlement time isn't bounded tightly enough to poll for
    // inline without risking this request's own timeout. Stores the raw,
    // uncapped buying power (not the tradableBalanceDollars-capped `balance`
    // used for sizing) — the watcher needs the real pre-trade figure to
    // measure how much it actually dropped.
    preEntryBuyingPower: config.liveMode ? balanceSummary.futuresBuyingPower : null,
    liquidationVerified: !config.liveMode,
  };
  const positionRef = await positionsCol.add(positionDoc);
  logDraft.positionId = positionRef.id;

  const tradeDoc: TradeDoc = {
    positionId: positionRef.id,
    asset,
    leg: "entry",
    side: payload.side,
    size: Number(size),
    price: entryPrice,
    time: Timestamp.now(),
    mode,
    orderId: entryOrderId,
    raw: null,
  };
  await tradesCol.add(tradeDoc);

  return `entered:${mode}:${size}`;
}

async function handleFlatten(
  asset: Asset,
  config: Awaited<ReturnType<typeof getConfig>>,
  creds: { apiKeyName: string; privateKeyPem: string },
  logDraft: TradeLogDraft
): Promise<string> {
  logDraft.config = {
    liveMode: config.liveMode,
    globalKillSwitch: config.globalKillSwitch,
    assetKillSwitch: config.assetKillSwitches[asset],
    sessionLossLimitDollars: config.sessionLossLimitDollars,
    tradableBalanceDollars: config.tradableBalanceDollars,
  };

  // Reuses the entry lock rather than a separate one: only one position
  // exists system-wide at a time, so serializing every position-mutating
  // action (entry or flatten) behind a single lock is sufficient and avoids
  // the same double-fire race observed on entries (TradingView firing an
  // alert twice within the same second) from placing two real closing
  // orders back-to-back.
  const acquired = await acquireActionLock();
  if (!acquired) {
    return "blocked:action_in_progress";
  }
  try {
    const result = await closeOpenPosition(asset, config, creds);
    logDraft.positionId = result.positionId;
    logDraft.order = {
      entryOrderId: null,
      entryPrice: null,
      bracketOrderId: null,
      tpPrice: null,
      slPrice: null,
      exitOrderId: result.exitOrderId,
      exitPrice: result.exitPrice,
    };
    return result.closed
      ? `flattened:${config.liveMode ? "live" : "dry_run"}`
      : "no_open_position";
  } finally {
    await releaseActionLock();
  }
}
