import { onSchedule } from "firebase-functions/scheduler";
import { db } from "./admin";
import { coinbaseApiKeyName, coinbaseApiPrivateKey } from "./secrets";
import { PRODUCT_IDS, cancelOrder, placeBracketOrder } from "./coinbase/client";
import { acquireActionLock, releaseActionLock } from "./lock";
import { STALE_AFTER_DAYS, STALE_TP_DOLLARS } from "./staleTp";
import { PositionDoc } from "./types";

const positionsCol = db.collection("positions");

// Live btc4h positions get a real Coinbase bracket order at entry, sized off
// the position's original tpDollars/slDollars — unlike every other asset,
// btc4h can hold for weeks, so its take-profit needs to tighten once stale
// (see staleTp.ts) by actually amending that live bracket order, not just
// recomputing a threshold on read like the dry-run watcher does. Runs every
// minute; a position is only ever amended once (staleAmended guards against
// re-cancelling/re-placing on every subsequent tick).
export const watchStaleTp = onSchedule(
  {
    schedule: "* * * * *",
    timeZone: "America/New_York",
    secrets: [coinbaseApiKeyName, coinbaseApiPrivateKey],
  },
  async () => {
    const openSnap = await positionsCol
      .where("status", "==", "open")
      .where("mode", "==", "live")
      .where("asset", "==", "btc4h")
      .limit(1)
      .get();
    if (openSnap.empty) return;

    const positionRef = openSnap.docs[0].ref;
    const position = openSnap.docs[0].data() as PositionDoc;
    if (position.staleAmended) return;
    if (!position.bracketOrderId || position.slDollars == null) return;

    const ageMs = Date.now() - position.entryTime.toMillis();
    const staleAfterMs = STALE_AFTER_DAYS * 24 * 60 * 60 * 1000;
    if (ageMs < staleAfterMs) return;

    const creds = {
      apiKeyName: coinbaseApiKeyName.value(),
      privateKeyPem: coinbaseApiPrivateKey.value(),
    };

    // Shared with every other close/order-touching path — this could race
    // with a flatten or kill-switch trip on the same open position at the
    // same minute-boundary tick.
    const acquired = await acquireActionLock();
    if (!acquired) return;
    try {
      const productId = PRODUCT_IDS[position.asset];
      const closingSide = position.side === "long" ? "SELL" : "BUY";
      const tpPrice =
        position.side === "long"
          ? position.entryPrice + STALE_TP_DOLLARS
          : position.entryPrice - STALE_TP_DOLLARS;
      const slPrice =
        position.side === "long"
          ? position.entryPrice - position.slDollars
          : position.entryPrice + position.slDollars;

      // Only place the replacement bracket if the cancel is actually
      // confirmed — Coinbase has no atomic "amend" for bracket orders (edit
      // order only supports plain GTC limit orders), so this is the only way
      // to do it, but placing a new bracket after a cancel that silently
      // failed would leave two live orders resting on the same position at
      // once. A cancel failure here most likely means the order already
      // filled (position already closing/closed) — bailing out and letting
      // the next tick reassess is correct either way; syncLiveBracketFills
      // will pick up an actual fill on its own.
      const cancelled = await cancelOrder(creds, position.bracketOrderId);
      if (!cancelled) return;

      const bracket = await placeBracketOrder(
        creds,
        productId,
        closingSide,
        String(position.size),
        tpPrice.toFixed(8),
        slPrice.toFixed(8)
      );

      await positionRef.update({
        bracketOrderId: bracket.orderId,
        staleAmended: true,
      });
    } finally {
      await releaseActionLock();
    }
  }
);
