import { onSchedule } from "firebase-functions/scheduler";
import { db, ASSETS, Asset } from "./admin";
import { coinbaseApiKeyName, coinbaseApiPrivateKey } from "./secrets";
import { getConfig } from "./config";
import { closeOpenPosition } from "./positionActions";
import { PRODUCT_IDS, getProduct } from "./coinbase/client";
import { PositionDoc } from "./types";

function todayKey(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
  }).format(new Date());
}

// Runs every minute so the session-loss kill switch reacts to an open
// position's unrealized loss, not just losses already realized at trade
// close (which the at-close check in positionActions.ts already covers
// instantly). Together these mean the kill switch can trip whether the
// breach happens mid-trade or only becomes clear once a trade closes.
export const monitorSessionLoss = onSchedule(
  {
    schedule: "* * * * *",
    timeZone: "America/New_York",
    secrets: [coinbaseApiKeyName, coinbaseApiPrivateKey],
  },
  async () => {
    const config = await getConfig();
    if (config.globalKillSwitch) return; // already tripped, nothing to do

    const statsRef = db.collection("dailyStats").doc(todayKey());
    const statsSnap = await statsRef.get();
    const realizedPnl = statsSnap.exists ? statsSnap.data()?.realizedPnl ?? 0 : 0;

    const openSnap = await db
      .collection("positions")
      .where("status", "==", "open")
      .limit(1)
      .get();

    const creds = {
      apiKeyName: coinbaseApiKeyName.value(),
      privateKeyPem: coinbaseApiPrivateKey.value(),
    };

    let unrealizedPnl = 0;
    let openAsset: Asset | null = null;
    if (!openSnap.empty) {
      const position = openSnap.docs[0].data() as PositionDoc;
      openAsset = position.asset;
      try {
        const product = await getProduct(creds, PRODUCT_IDS[position.asset]);
        const priceDiff =
          position.side === "long"
            ? product.price - position.entryPrice
            : position.entryPrice - product.price;
        const gross = priceDiff * position.size * position.contractSize;
        const fee = position.feePerContract * position.size;
        unrealizedPnl = gross - fee;
      } catch {
        unrealizedPnl = 0;
      }
    }

    const sessionLoss = -(realizedPnl + unrealizedPnl);
    if (sessionLoss < config.sessionLossLimitDollars) return;

    const assetUpdates = Object.fromEntries(
      ASSETS.map((a) => [a, true])
    ) as Record<Asset, boolean>;
    await db
      .collection("system")
      .doc("config")
      .set({ globalKillSwitch: true, assetKillSwitches: assetUpdates }, { merge: true });
    await statsRef.set({ killSwitchTriggered: true }, { merge: true });

    if (openAsset) {
      const freshConfig = await getConfig();
      await closeOpenPosition(openAsset, freshConfig, creds);
    }
  }
);
