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
  getOrder,
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

    const payload = req.body as Partial<WebhookPayload>;

    if (!payload || typeof payload.secret !== "string") {
      res.status(400).send("Bad request");
      return;
    }
    if (!secretsMatch(payload.secret, webhookSharedSecret.value())) {
      logger.warn("Webhook received with invalid secret");
      res.status(401).send("Unauthorized");
      return;
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

    const fill = await getOrder(creds, entryOrder.orderId);
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
  const closed = await closeOpenPosition(asset, config, creds);
  return closed ? `flattened:${config.liveMode ? "live" : "dry_run"}` : "no_open_position";
}
