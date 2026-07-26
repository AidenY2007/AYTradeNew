import { Timestamp } from "firebase-admin/firestore";
import { onCall, HttpsError } from "firebase-functions/https";
import { db, OWNER_UID, Asset } from "./admin";
import { coinbaseApiKeyName, coinbaseApiPrivateKey } from "./secrets";
import { getConfig } from "./config";
import { closeOpenPosition } from "./positionActions";
import {
  PRODUCT_IDS,
  getProduct,
  placeMarketOrder,
  getOrder,
} from "./coinbase/client";
import { PositionDoc, TradeDoc } from "./types";

const positionsCol = db.collection("positions");
const tradesCol = db.collection("trades");

function requireOwner(auth: { uid: string } | undefined) {
  if (!auth || auth.uid !== OWNER_UID) {
    throw new HttpsError("permission-denied", "Not authorized.");
  }
}

// Manual test of the live order path: places one real short contract on
// BTC nano perp (0.01 BTC notional), independent of the liveMode toggle —
// this button's entire purpose is to exercise the real Coinbase order flow
// in isolation, deliberately at minimum size. No bracket TP/SL is placed;
// this is a bare entry/exit test only.
export const testLiveShortEntry = onCall(
  { secrets: [coinbaseApiKeyName, coinbaseApiPrivateKey] },
  async (request) => {
    requireOwner(request.auth);

    const openSnap = await positionsCol
      .where("status", "==", "open")
      .limit(1)
      .get();
    if (!openSnap.empty) {
      throw new HttpsError(
        "failed-precondition",
        "A position is already open — close it before testing."
      );
    }

    const config = await getConfig();
    const creds = {
      apiKeyName: coinbaseApiKeyName.value(),
      privateKeyPem: coinbaseApiPrivateKey.value(),
    };
    const productId = PRODUCT_IDS.btc;
    const product = await getProduct(creds, productId);

    const size = "1"; // exactly 1 contract = 0.01 BTC, fixed for this test
    const order = await placeMarketOrder(creds, productId, "SELL", size);
    const fill = await getOrder(creds, order.orderId);
    const entryPrice = fill.avgFilledPrice ?? product.price;

    const positionDoc: PositionDoc = {
      asset: "btc",
      side: "short",
      size: 1,
      contractSize: product.contractSize,
      feePerContract: config.feesPerContract.btc,
      leverage: 1,
      entryPrice,
      entryTime: Timestamp.now(),
      exitPrice: null,
      exitTime: null,
      status: "open",
      mode: "live",
      pnl: null,
      fee: null,
      bracketOrderId: null,
      entryOrderId: order.orderId,
    };
    const positionRef = await positionsCol.add(positionDoc);

    const tradeDoc: TradeDoc = {
      positionId: positionRef.id,
      asset: "btc",
      leg: "entry",
      side: "short",
      size: 1,
      price: entryPrice,
      time: Timestamp.now(),
      mode: "live",
      orderId: order.orderId,
      raw: null,
    };
    await tradesCol.add(tradeDoc);

    return { ok: true, entryPrice, orderId: order.orderId };
  }
);

// Closes whatever position is currently open (there can only be one
// system-wide), reusing the same close path as the webhook flatten and
// kill-switch flows.
export const closeTestPosition = onCall(
  { secrets: [coinbaseApiKeyName, coinbaseApiPrivateKey] },
  async (request) => {
    requireOwner(request.auth);

    const openSnap = await positionsCol
      .where("status", "==", "open")
      .limit(1)
      .get();
    if (openSnap.empty) {
      throw new HttpsError("failed-precondition", "No open position.");
    }
    const asset = openSnap.docs[0].data().asset as Asset;

    const config = await getConfig();
    const creds = {
      apiKeyName: coinbaseApiKeyName.value(),
      privateKeyPem: coinbaseApiPrivateKey.value(),
    };
    await closeOpenPosition(asset, config, creds);
    return { ok: true };
  }
);
