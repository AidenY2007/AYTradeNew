import { Timestamp } from "firebase-admin/firestore";
import { db, Asset, ASSETS } from "./admin";
import { SystemConfig, PositionDoc, TradeDoc, ClosePositionResult } from "./types";
import {
  PRODUCT_IDS,
  getProduct,
  placeMarketOrder,
  placeBracketOrder,
  cancelOrder,
  getOrder,
  waitForFill,
  CoinbaseCredentials,
} from "./coinbase/client";
import { formatPrice } from "./sizing";

const positionsCol = db.collection("positions");
const tradesCol = db.collection("trades");

// Places the closing bracket (TP/SL) order for a position whose entry has
// already filled. If Coinbase rejects the bracket for any reason (the
// INVALID_PRICE_PRECISION bug this was written to guard against, a network
// blip, a rate limit — anything), the entry is left open on Coinbase with no
// stop-loss attached, which is worse than not being open at all: a
// duplicate webhook retry would see no Firestore record yet and pile on
// more entries on top of it, which is exactly how one bad bracket price
// turned into four unprotected live buys in production on 2026-08-21. Fails
// safe by immediately unwinding the entry rather than leaving it exposed,
// and throws either way so the caller's own error handling (logging,
// tradeLogs, etc.) still runs.
export async function placeBracketWithFailsafe(
  creds: CoinbaseCredentials,
  productId: string,
  closingSide: "BUY" | "SELL",
  size: string,
  tpPrice: number,
  slPrice: number,
  quoteIncrement: number,
  entryOrderId: string | null,
  entryPrice: number
): Promise<string> {
  try {
    const bracket = await placeBracketOrder(
      creds,
      productId,
      closingSide,
      size,
      formatPrice(tpPrice, quoteIncrement),
      formatPrice(slPrice, quoteIncrement)
    );
    return bracket.orderId;
  } catch (bracketErr) {
    let closeNote: string;
    try {
      const closeOrder = await placeMarketOrder(creds, productId, closingSide, size);
      const closeFill = await waitForFill(creds, closeOrder.orderId);
      closeNote = ` — auto-closed at ${closeFill.avgFilledPrice ?? "unknown price"} (order ${closeOrder.orderId})`;
    } catch (closeErr) {
      closeNote =
        ` — FAILED TO AUTO-CLOSE: ${closeErr instanceof Error ? closeErr.message : String(closeErr)}. ` +
        "Position is likely still open and UNPROTECTED on Coinbase — check manually.";
    }
    throw new Error(
      `Bracket order failed after entry filled (entryOrderId=${entryOrderId}, entryPrice=${entryPrice})${closeNote}. ` +
        `Original error: ${bracketErr instanceof Error ? bracketErr.message : String(bracketErr)}`
    );
  }
}

function dailyStatsRef() {
  const key = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
  }).format(new Date());
  return db.collection("dailyStats").doc(key);
}

// Shared bookkeeping for any position close, real or simulated: computes
// PnL, marks the position closed, updates today's realized PnL, and trips
// the session-loss kill switch if breached. Used both when this module
// actively places a closing order (closeOpenPosition) and when reconciling
// a position Coinbase already closed on its own via the bracket order
// (liveBracketSync.ts) — in the latter case no order is placed, only
// Firestore state is brought in line with what already happened.
export async function finalizePositionClose(
  positionRef: FirebaseFirestore.DocumentReference,
  position: PositionDoc,
  exitPrice: number,
  config: SystemConfig
): Promise<void> {
  // PnL scales with contractSize — each contract represents that many units
  // of the underlying, not a 1:1 dollar-per-point move.
  const grossPnl =
    (position.side === "long"
      ? exitPrice - position.entryPrice
      : position.entryPrice - exitPrice) *
    position.size *
    position.contractSize;

  const fee = (position.feePerContract ?? 0) * position.size;
  const pnl = grossPnl - fee;

  await positionRef.update({
    status: "closed",
    exitPrice,
    exitTime: Timestamp.now(),
    pnl,
    fee,
  });

  const statsRef = dailyStatsRef();
  const statsSnap = await statsRef.get();
  const statsData = statsSnap.exists ? statsSnap.data() : null;
  const realizedPnl = (statsData?.realizedPnl ?? 0) + pnl;

  // Session-loss kill switch: if realized losses for the session (today)
  // breach the configured raw dollar amount, auto-disable new entries.
  // Nothing open at this exact instant (this position just closed and the
  // system only ever allows one at a time), so realized PnL alone is the
  // complete session PnL here — the scheduled monitor covers the
  // in-between case where a position is still open and unrealized.
  const sessionLoss = -realizedPnl;
  const killSwitchTriggered =
    statsData?.killSwitchTriggered ||
    sessionLoss >= config.sessionLossLimitDollars;

  await statsRef.set({ realizedPnl, killSwitchTriggered }, { merge: true });

  if (killSwitchTriggered && !statsData?.killSwitchTriggered) {
    // Global is a master switch (see killSwitch.ts) — keep every asset's
    // toggle consistent with it here too, not just on manual global flips.
    const assetUpdates = Object.fromEntries(
      ASSETS.map((a) => [a, true])
    ) as Record<Asset, boolean>;
    await db
      .collection("system")
      .doc("config")
      .set({ globalKillSwitch: true, assetKillSwitches: assetUpdates }, { merge: true });
  }
}

// Closes the currently open position for `asset`, if any: cancels its
// bracket order, market-closes it (or simulates in dry-run mode), and
// updates positions/trades/dailyStats. Shared by the webhook flatten path,
// manual kill switches, and the daily-loss auto kill switch.
export async function closeOpenPosition(
  asset: Asset,
  config: SystemConfig,
  creds: CoinbaseCredentials
): Promise<ClosePositionResult> {
  const snap = await positionsCol
    .where("asset", "==", asset)
    .where("status", "==", "open")
    .limit(1)
    .get();
  if (snap.empty) {
    return { closed: false, positionId: null, exitPrice: null, exitOrderId: null };
  }

  const positionRef = snap.docs[0].ref;
  const position = snap.docs[0].data() as PositionDoc;
  const productId = PRODUCT_IDS[asset];
  // Whether to place a real closing order must follow what the position
  // actually is, not the current global toggle — flipping liveMode off
  // after a real position was opened must never cause a real position to
  // be silently "closed" via simulation while it's still open on Coinbase.
  const mode = position.mode;
  const closingSide = position.side === "long" ? "SELL" : "BUY";

  let exitPrice = position.entryPrice;
  let exitOrderId: string | null = null;

  if (mode === "live") {
    // The exchange-side bracket order may have already closed this position
    // on its own (TP/SL hit) before this call ever ran — every caller here
    // (flatten webhook, kill switch, scheduled overdue-flatten, session-loss
    // trip) previously assumed the position was still live and would place
    // a fresh market order regardless. Placing another closing order against
    // an already-flat position doesn't "double close" it — it opens a
    // brand-new, unintended position in the opposite direction. Check the
    // bracket's own fill status first and only fall back to an active
    // market close if it genuinely hasn't triggered yet.
    const bracketFill = position.bracketOrderId
      ? await getOrder(creds, position.bracketOrderId).catch(() => null)
      : null;

    if (bracketFill && bracketFill.status === "FILLED") {
      exitPrice = bracketFill.avgFilledPrice ?? position.entryPrice;
      exitOrderId = position.bracketOrderId;
    } else {
      if (position.bracketOrderId) {
        const cancelled = await cancelOrder(creds, position.bracketOrderId).catch(() => false);
        if (!cancelled) {
          // Coinbase's cancel isn't necessarily settled the instant this
          // call returns — blindly placing a closing order for the full
          // size right after an unconfirmed cancel races the exchange's own
          // bookkeeping and gets rejected with
          // PREVIEW_ORDER_SIZE_EXCEEDS_BRACKETED_POSITION (seen in
          // production: a live btc4h position on 2026-08-04 sat unprotected
          // for a full minute because of this). Re-check once — the bracket
          // may have simply filled in the gap between the check above and
          // this cancel attempt — before giving up.
          const recheck = await getOrder(creds, position.bracketOrderId).catch(() => null);
          if (recheck && recheck.status === "FILLED") {
            exitPrice = recheck.avgFilledPrice ?? position.entryPrice;
            exitOrderId = position.bracketOrderId;
          } else {
            throw new Error(
              `Could not confirm cancellation of bracket order ${position.bracketOrderId} ` +
                `for position ${positionRef.id} — refusing to place a duplicate closing order.`
            );
          }
        }
      }
      if (!exitOrderId) {
        const exitOrder = await placeMarketOrder(
          creds,
          productId,
          closingSide,
          String(position.size)
        );
        exitOrderId = exitOrder.orderId;
        const fill = await waitForFill(creds, exitOrder.orderId);
        exitPrice = fill.avgFilledPrice ?? position.entryPrice;
      }
    }
  } else {
    const product = await getProduct(creds, asset);
    exitPrice = product.price;
  }

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

  await finalizePositionClose(positionRef, position, exitPrice, config);

  return { closed: true, positionId: positionRef.id, exitPrice, exitOrderId };
}
