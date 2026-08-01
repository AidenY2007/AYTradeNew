import { onSchedule } from "firebase-functions/scheduler";
import { Timestamp } from "firebase-admin/firestore";
import { db } from "./admin";
import { coinbaseApiKeyName, coinbaseApiPrivateKey } from "./secrets";
import { getConfig } from "./config";
import { getBalanceSummary } from "./coinbase/client";
import { closeOpenPosition } from "./positionActions";
import { acquireActionLock, releaseActionLock } from "./lock";
import { PositionDoc } from "./types";

const positionsCol = db.collection("positions");
const errorsCol = db.collection("errors");

async function logError(context: string, message: string) {
  await errorsCol.add({
    time: Timestamp.now(),
    context,
    message,
  });
}

// Verifies the stop-loss will trigger well before liquidation, using
// Coinbase's own account-level liquidation buffer (balance_summary's
// overnight_margin_window_measure.liquidation_buffer — there's no
// per-position liquidation price on their CFM position endpoints, confirmed
// against their API docs). Runs asynchronously on this schedule rather than
// blocking the webhook response: Coinbase's balance summary can lag behind a
// just-filled order by an unknown amount, and there's no bound tight enough
// to poll for inline without risking the webhook request's own timeout.
// Every minute, picks up any live position whose check hasn't resolved yet.
export const watchLiquidationSafety = onSchedule(
  {
    schedule: "* * * * *",
    timeZone: "America/New_York",
    secrets: [coinbaseApiKeyName, coinbaseApiPrivateKey],
  },
  async () => {
    const openSnap = await positionsCol
      .where("status", "==", "open")
      .where("mode", "==", "live")
      .where("liquidationVerified", "==", false)
      .limit(1)
      .get();
    if (openSnap.empty) return;

    const positionRef = openSnap.docs[0].ref;
    const position = openSnap.docs[0].data() as PositionDoc;
    if (position.preEntryBuyingPower == null) {
      // Nothing to compare a settled read against — mark resolved rather
      // than block on this position forever.
      await positionRef.update({ liquidationVerified: true });
      return;
    }

    const creds = {
      apiKeyName: coinbaseApiKeyName.value(),
      privateKeyPem: coinbaseApiPrivateKey.value(),
    };

    let balanceSummary;
    try {
      balanceSummary = await getBalanceSummary(creds);
    } catch {
      return; // transient API failure — next minute's tick will retry
    }

    // Compares against this position's own expected margin usage (derived
    // from its recorded size/price/leverage) rather than assuming sizing
    // committed close to the account's entire buying power — that
    // assumption breaks once tradableBalanceDollars caps a position to a
    // small fraction of real buying power, where the account-wide number
    // barely moves at all even once genuinely settled.
    const notionalUsed = position.size * position.contractSize * position.entryPrice;
    const expectedMargin = position.leverage > 0 ? notionalUsed / position.leverage : 0;
    const actualDrop = position.preEntryBuyingPower - balanceSummary.futuresBuyingPower;
    const settled = expectedMargin > 0 && actualDrop >= expectedMargin * 0.5;

    const ageMs = Date.now() - position.entryTime.toMillis();
    const MAX_WAIT_MS = 5 * 60 * 1000; // generous grace period for settlement

    if (!settled) {
      if (ageMs > MAX_WAIT_MS) {
        await flattenAsUnsafe(
          position,
          positionRef,
          creds,
          `Balance summary never settled within ${MAX_WAIT_MS / 1000}s of entry — treating as unconfirmed.`
        );
      }
      return; // otherwise, wait for next minute's tick
    }

    const SAFETY_BUFFER = 1.2;
    const bufferUsd = balanceSummary.overnightLiquidationBufferUsd;
    const dollarsPerPoint = position.size * position.contractSize;
    const slDollars = position.slDollars ?? 0;

    if (bufferUsd == null || dollarsPerPoint <= 0) {
      await flattenAsUnsafe(
        position,
        positionRef,
        creds,
        `Could not read overnight liquidation buffer from Coinbase balance summary: ${JSON.stringify(balanceSummary.raw)}`
      );
      return;
    }

    const liqDistance = bufferUsd / dollarsPerPoint;
    if (liqDistance < slDollars * SAFETY_BUFFER) {
      await flattenAsUnsafe(
        position,
        positionRef,
        creds,
        `Liquidation too close to stop-loss: liqDistance=${liqDistance}, ` +
          `slDollars=${slDollars}, bufferUsd=${bufferUsd}, dollarsPerPoint=${dollarsPerPoint}`
      );
      return;
    }

    await positionRef.update({ liquidationVerified: true });
  }
);

async function flattenAsUnsafe(
  position: PositionDoc,
  positionRef: FirebaseFirestore.DocumentReference,
  creds: { apiKeyName: string; privateKeyPem: string },
  reason: string
): Promise<void> {
  // Shared with every other close-touching path — this position could also
  // be past its flatten time or breaching the session-loss limit at the
  // exact same minute-boundary tick. Acquired before logging, so a busy
  // lock just retries quietly next minute instead of logging a duplicate
  // "emergency flatten" error every tick until it succeeds.
  const acquired = await acquireActionLock();
  if (!acquired) return; // next minute's tick will retry
  try {
    await logError(`liquidationWatcher:${position.asset}`, `Emergency flatten: ${reason}`);
    const config = await getConfig();
    await closeOpenPosition(position.asset, config, creds);
    await positionRef.update({ liquidationVerified: true });
  } finally {
    await releaseActionLock();
  }
}
