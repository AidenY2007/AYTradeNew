import { onSchedule } from "firebase-functions/scheduler";
import { db } from "./admin";
import { coinbaseApiKeyName, coinbaseApiPrivateKey } from "./secrets";
import { getConfig } from "./config";
import { closeOpenPosition } from "./positionActions";
import { PRODUCT_IDS, getProduct } from "./coinbase/client";
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
      const product = await getProduct(creds, PRODUCT_IDS[position.asset]);
      price = product.price;
    } catch {
      return;
    }

    const hitTp =
      position.tpDollars != null &&
      (position.side === "long"
        ? price >= position.entryPrice + position.tpDollars
        : price <= position.entryPrice - position.tpDollars);
    const hitSl =
      position.slDollars != null &&
      (position.side === "long"
        ? price <= position.entryPrice - position.slDollars
        : price >= position.entryPrice + position.slDollars);

    if (!hitTp && !hitSl) return;

    const config = await getConfig();
    await closeOpenPosition(position.asset, config, creds);
  }
);
