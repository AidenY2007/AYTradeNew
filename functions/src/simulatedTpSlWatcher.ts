import { onSchedule } from "firebase-functions/scheduler";
import { db } from "./admin";
import { coinbaseApiKeyName, coinbaseApiPrivateKey } from "./secrets";
import { getConfig } from "./config";
import { closeOpenPosition } from "./positionActions";
import { acquireActionLock, releaseActionLock } from "./lock";
import { getProduct } from "./coinbase/client";
import { PositionDoc } from "./types";

// Dry-run positions never get a real Coinbase bracket order, so nothing
// exchange-side enforces their TP/SL. This simulates that enforcement:
// runs every minute and closes a dry-run position the moment the current
// price has crossed its recorded tp/sl level. Live positions are never
// touched here — Coinbase's own bracket order remains the sole real
// enforcement for those, exactly as before.
export const watchSimulatedTpSl = onSchedule(
  {
    schedule: "* * * * *",
    timeZone: "America/New_York",
    secrets: [coinbaseApiKeyName, coinbaseApiPrivateKey],
  },
  async () => {
    const openSnap = await db
      .collection("positions")
      .where("status", "==", "open")
      .where("mode", "==", "dry_run")
      .limit(1)
      .get();
    if (openSnap.empty) return;

    const position = openSnap.docs[0].data() as PositionDoc;
    if (position.tpDollars == null && position.slDollars == null) return;

    const creds = {
      apiKeyName: coinbaseApiKeyName.value(),
      privateKeyPem: coinbaseApiPrivateKey.value(),
    };

    let price: number;
    try {
      const product = await getProduct(creds, position.asset);
      price = product.price;
    } catch {
      return;
    }

    const tpDollars = position.tpDollars;
    const hitTp =
      tpDollars != null &&
      (position.side === "long"
        ? price >= position.entryPrice + tpDollars
        : price <= position.entryPrice - tpDollars);
    const hitSl =
      position.slDollars != null &&
      (position.side === "long"
        ? price <= position.entryPrice - position.slDollars
        : price >= position.entryPrice + position.slDollars);

    if (!hitTp && !hitSl) return;

    // Shared with every other close-touching path — this position could
    // also be past its flatten time or breaching the session-loss limit at
    // the exact same minute-boundary tick, so without this lock those
    // scheduled jobs could race on the same close.
    const acquired = await acquireActionLock();
    if (!acquired) return;
    try {
      const config = await getConfig();
      await closeOpenPosition(position.asset, config, creds);
    } finally {
      await releaseActionLock();
    }
  }
);
