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
import { checkEntryAllowed } from "./tradingWindow";
import {
  PRODUCT_IDS,
  getBalanceSummary,
  getProduct,
  maxLeverageForSide,
  placeMarketOrder,
  placeBracketOrder,
  waitForFill,
} from "./coinbase/client";
import { computeMaxContractsSize } from "./sizing";
import { closeOpenPosition } from "./positionActions";
import {
  WebhookPayload,
  MissedEntryReason,
  PositionDoc,
  TradeDoc,
} from "./types";

const positionsCol = db.collection("positions");
const tradesCol = db.collection("trades");
const missedEntriesCol = db.collection("missedEntries");
const errorsCol = db.collection("errors");

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

// Guards against two entry webhooks arriving within milliseconds of each
// other (observed in practice — TradingView can fire "Order fills only"
// twice for what's logically one entry) both reading "no open position"
// before either has finished writing one, which would place two real
// orders. A Firestore transaction on this singleton doc makes the
// check-and-claim atomic; the lock auto-expires after 60s in case a
// request crashes mid-entry without releasing it, so a real failure can
// never permanently block future entries.
const entryLockRef = db.collection("system").doc("entryLock");

async function acquireEntryLock(): Promise<boolean> {
  return db.runTransaction(async (t) => {
    const snap = await t.get(entryLockRef);
    const data = snap.exists ? snap.data() : null;
    const lockedAt = data?.lockedAt as Timestamp | undefined;
    const isStale = lockedAt ? Date.now() - lockedAt.toMillis() > 60000 : false;
    if (data?.locked && !isStale) {
      return false;
    }
    t.set(entryLockRef, { locked: true, lockedAt: Timestamp.now() });
    return true;
  });
}

async function releaseEntryLock() {
  await entryLockRef.set({ locked: false }, { merge: true });
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
  { secrets: [coinbaseApiKeyName, coinbaseApiPrivateKey, webhookSharedSecret] },
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

    try {
      const config = await getConfig();

      const outcome =
        payload.action === "entry"
          ? await handleEntry(asset, payload, config, creds)
          : await handleFlatten(asset, config, creds);
      res.status(200).send(outcome);
    } catch (err) {
      await logError(`webhook:${payload.action}:${asset}`, err);
      res.status(500).send("error");
    }
  }
);

async function handleEntry(
  asset: Asset,
  payload: Partial<WebhookPayload>,
  config: Awaited<ReturnType<typeof getConfig>>,
  creds: { apiKeyName: string; privateKeyPem: string }
): Promise<string> {
  if (config.globalKillSwitch) {
    await logMissedEntry(asset, "kill_switch_active", payload);
    return "blocked:kill_switch_active";
  }
  if (config.assetKillSwitches[asset]) {
    await logMissedEntry(asset, "kill_switch_active", payload);
    return "blocked:kill_switch_active";
  }

  const acquired = await acquireEntryLock();
  if (!acquired) {
    await logMissedEntry(asset, "position_already_open", payload);
    return "blocked:position_already_open";
  }
  try {
    return await handleEntryLocked(asset, payload, config, creds);
  } finally {
    await releaseEntryLock();
  }
}

async function handleEntryLocked(
  asset: Asset,
  payload: Partial<WebhookPayload>,
  config: Awaited<ReturnType<typeof getConfig>>,
  creds: { apiKeyName: string; privateKeyPem: string }
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

  if (!payload.side || (payload.side !== "long" && payload.side !== "short")) {
    await logMissedEntry(asset, "invalid_payload", payload);
    return "blocked:invalid_payload";
  }

  const productId = PRODUCT_IDS[asset];
  const mode = config.liveMode ? "live" : "dry_run";

  const [balanceSummary, product] = await Promise.all([
    getBalanceSummary(creds),
    getProduct(creds, productId),
  ]);

  // Tech/AI/China follow real equity-index market hours, unlike BTC's
  // 24/7 session — this is separate from (and in addition to) our own
  // Pine-mirrored timing rules.
  if (!product.isSessionOpen) {
    await logMissedEntry(asset, "market_session_closed", payload);
    return "blocked:market_session_closed";
  }

  const balance = balanceSummary.futuresBuyingPower || balanceSummary.totalUsdBalance;
  const leverage = maxLeverageForSide(product, payload.side);
  const size = computeMaxContractsSize(
    balance,
    product.price,
    leverage,
    product.baseIncrement,
    product.contractSize
  );

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

  if (config.liveMode) {
    const entryOrder = await placeMarketOrder(creds, productId, orderSide, size);
    entryOrderId = entryOrder.orderId;

    const fill = await waitForFill(creds, entryOrder.orderId);
    entryPrice = fill.avgFilledPrice ?? product.price;

    const tpDollars = payload.tpDollars ?? 0;
    const slDollars = payload.slDollars ?? 0;
    const tpPrice =
      payload.side === "long" ? entryPrice + tpDollars : entryPrice - tpDollars;
    const slPrice =
      payload.side === "long" ? entryPrice - slDollars : entryPrice + slDollars;

    const bracket = await placeBracketOrder(
      creds,
      productId,
      closingSide,
      size,
      tpPrice.toFixed(8),
      slPrice.toFixed(8)
    );
    bracketOrderId = bracket.orderId;
  }

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
  };
  const positionRef = await positionsCol.add(positionDoc);

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
  creds: { apiKeyName: string; privateKeyPem: string }
): Promise<string> {
  // Reuses the entry lock rather than a separate one: only one position
  // exists system-wide at a time, so serializing every position-mutating
  // action (entry or flatten) behind a single lock is sufficient and avoids
  // the same double-fire race observed on entries (TradingView firing an
  // alert twice within the same second) from placing two real closing
  // orders back-to-back.
  const acquired = await acquireEntryLock();
  if (!acquired) {
    return "blocked:action_in_progress";
  }
  try {
    const closed = await closeOpenPosition(asset, config, creds);
    return closed ? `flattened:${config.liveMode ? "live" : "dry_run"}` : "no_open_position";
  } finally {
    await releaseEntryLock();
  }
}
