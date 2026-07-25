import { Timestamp } from "firebase-admin/firestore";
import { db, Asset } from "./admin";
import { SystemConfig, PositionDoc, TradeDoc } from "./types";
import {
  PRODUCT_IDS,
  getBalanceSummary,
  getProduct,
  placeMarketOrder,
  cancelOrder,
  getOrder,
  CoinbaseCredentials,
} from "./coinbase/client";

const positionsCol = db.collection("positions");
const tradesCol = db.collection("trades");

function dailyStatsRef() {
  const key = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
  }).format(new Date());
  return db.collection("dailyStats").doc(key);
}

// Closes the currently open position for `asset`, if any: cancels its
// bracket order, market-closes it (or simulates in dry-run mode), and
// updates positions/trades/dailyStats. Shared by the webhook flatten path,
// manual kill switches, and the daily-loss auto kill switch.
export async function closeOpenPosition(
  asset: Asset,
  config: SystemConfig,
  creds: CoinbaseCredentials
): Promise<boolean> {
  const snap = await positionsCol
    .where("asset", "==", asset)
    .where("status", "==", "open")
    .limit(1)
    .get();
  if (snap.empty) return false;

  const positionRef = snap.docs[0].ref;
  const position = snap.docs[0].data() as PositionDoc;
  const productId = PRODUCT_IDS[asset];
  const closingSide = position.side === "long" ? "SELL" : "BUY";
  const mode = config.liveMode ? "live" : "dry_run";

  let exitPrice = position.entryPrice;
  let exitOrderId: string | null = null;

  if (config.liveMode) {
    if (position.bracketOrderId) {
      await cancelOrder(creds, position.bracketOrderId);
    }
    const exitOrder = await placeMarketOrder(
      creds,
      productId,
      closingSide,
      String(position.size)
    );
    exitOrderId = exitOrder.orderId;
    const fill = await getOrder(creds, exitOrder.orderId);
    exitPrice = fill.avgFilledPrice ?? position.entryPrice;
  } else {
    const product = await getProduct(creds, productId);
    exitPrice = product.price;
  }

  const pnl =
    (position.side === "long"
      ? exitPrice - position.entryPrice
      : position.entryPrice - exitPrice) * position.size;

  await positionRef.update({
    status: "closed",
    exitPrice,
    exitTime: Timestamp.now(),
    pnl,
  });

  const tradeDoc: TradeDoc = {
    positionId: positionRef.id,
    asset,
    leg: "exit",
    side: position.side,
    size: position.size,
    price: exitPrice,
    time: Timestamp.now(),
    mode,
    orderId: exitOrderId,
    raw: null,
  };
  await tradesCol.add(tradeDoc);

  const statsRef = dailyStatsRef();
  const statsSnap = await statsRef.get();
  const statsData = statsSnap.exists ? statsSnap.data() : null;
  const balanceSummary = await getBalanceSummary(creds).catch(() => null);
  const balanceStart =
    statsData?.balanceStart ?? balanceSummary?.totalUsdBalance ?? 0;
  const realizedPnl = (statsData?.realizedPnl ?? 0) + pnl;

  // Daily-loss kill switch: if realized losses for the day breach the
  // configured % of the day's starting balance, auto-disable new entries.
  const lossPct = balanceStart > 0 ? (-realizedPnl / balanceStart) * 100 : 0;
  const killSwitchTriggered =
    statsData?.killSwitchTriggered ||
    lossPct >= config.dailyLossKillSwitchPct;

  await statsRef.set(
    { balanceStart, realizedPnl, killSwitchTriggered },
    { merge: true }
  );

  if (killSwitchTriggered && !statsData?.killSwitchTriggered) {
    await db
      .collection("system")
      .doc("config")
      .set({ globalKillSwitch: true }, { merge: true });
  }

  return true;
}
