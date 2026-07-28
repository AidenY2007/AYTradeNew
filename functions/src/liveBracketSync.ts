import { Timestamp } from "firebase-admin/firestore";
import { onSchedule } from "firebase-functions/scheduler";
import { db } from "./admin";
import { coinbaseApiKeyName, coinbaseApiPrivateKey } from "./secrets";
import { getConfig } from "./config";
import { getOrder } from "./coinbase/client";
import { finalizePositionClose } from "./positionActions";
import { acquireActionLock, releaseActionLock } from "./lock";
import { PositionDoc, TradeDoc } from "./types";

const positionsCol = db.collection("positions");
const tradesCol = db.collection("trades");

// Coinbase's exchange-side bracket order is what actually closes a live
// position in real time (see webhook.ts) — but nothing was watching for
// that fill and reflecting it back into Firestore. Without this, a live
// position that already closed on Coinbase kept showing "open" here until
// the next explicit close attempt (a matching Pine flatten webhook, or the
// scheduled daily flatten), which both misrepresents the dashboard and,
// since the single-open-position rule is enforced purely server-side now,
// silently blocks every new entry system-wide in the meantime. Runs every
// minute, checks the one open live position's bracket order, and
// reconciles Firestore the moment Coinbase shows it filled — without
// placing any new order, since Coinbase already closed the real position.
export const syncLiveBracketFills = onSchedule(
  {
    schedule: "* * * * *",
    timeZone: "America/New_York",
    secrets: [coinbaseApiKeyName, coinbaseApiPrivateKey],
  },
  async () => {
    const openSnap = await positionsCol
      .where("status", "==", "open")
      .where("mode", "==", "live")
      .limit(1)
      .get();
    if (openSnap.empty) return;

    const positionRef = openSnap.docs[0].ref;
    const position = openSnap.docs[0].data() as PositionDoc;
    if (!position.bracketOrderId) return;

    const creds = {
      apiKeyName: coinbaseApiKeyName.value(),
      privateKeyPem: coinbaseApiPrivateKey.value(),
    };

    const fill = await getOrder(creds, position.bracketOrderId).catch(() => null);
    if (!fill || fill.status !== "FILLED") return;

    // Shared with every other close-touching path — flattenOverduePositions
    // and monitorSessionLoss run on this exact same every-minute schedule
    // and don't filter by mode, so either could be racing to close this
    // same live position right now. Without this lock both could write a
    // duplicate exit trade doc and double-apply the PnL delta to
    // dailyStats.realizedPnl.
    const acquired = await acquireActionLock();
    if (!acquired) return;
    try {
      const exitPrice = fill.avgFilledPrice ?? position.entryPrice;
      const tradeDoc: TradeDoc = {
        positionId: positionRef.id,
        asset: position.asset,
        leg: "exit",
        side: position.side,
        size: position.size,
        price: exitPrice,
        time: Timestamp.now(),
        mode: "live",
        orderId: position.bracketOrderId,
        raw: null,
      };
      await tradesCol.add(tradeDoc);

      const config = await getConfig();
      await finalizePositionClose(positionRef, position, exitPrice, config);
    } finally {
      await releaseActionLock();
    }
  }
);
