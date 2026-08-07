import { onSchedule } from "firebase-functions/scheduler";
import * as logger from "firebase-functions/logger";
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

// Also writes to Cloud Logging (unlike the Firestore-only version this used
// to be) — the `errors` doc is the primary read path from the dashboard, but
// it's a normal Firestore document with no special protection: one got
// manually deleted while debugging a real incident and took the only record
// of *why* a position was flattened with it. Cloud Logging survives that.
async function logError(context: string, message: string) {
  logger.error(context, message);
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
    // Real settlement lag on Coinbase's side isn't tightly bounded (see the
    // comment above this function), and the old 5-minute cutoff force-closed
    // a real btc4h position on 2026-08-04 whose stop-loss was $6,500 away —
    // this proxy metric simply hadn't confirmed yet, nothing was actually
    // wrong. Widened well past any observed real settlement time as a grace
    // period. Just as importantly, an expired grace period no longer
    // flattens by itself below — it only stops waiting and falls through to
    // checking the real liquidation buffer directly, which is the actual
    // safety signal. If that buffer looks fine, an unsettled proxy read
    // alone is no longer reason to close a healthy position.
    const MAX_WAIT_MS = 15 * 60 * 1000;

    if (!settled && ageMs <= MAX_WAIT_MS) {
      return; // still within grace period — wait for next minute's tick
    }

    const SAFETY_BUFFER = 1.2;
    const bufferUsd = balanceSummary.overnightLiquidationBufferUsd;
    const dollarsPerPoint = position.size * position.contractSize;
    const slDollars = position.slDollars ?? 0;

    if (bufferUsd == null || dollarsPerPoint <= 0) {
      const reason = settled
        ? `Could not read overnight liquidation buffer from Coinbase balance summary: ${JSON.stringify(balanceSummary.raw)}`
        : `Balance summary never settled within ${MAX_WAIT_MS / 1000}s of entry, and no liquidation buffer ` +
          `is readable either — treating as unconfirmed: ${JSON.stringify(balanceSummary.raw)}`;
      await flattenAsUnsafe(position, positionRef, creds, reason);
      return;
    }

    const liqDistance = bufferUsd / dollarsPerPoint;
    if (liqDistance < slDollars * SAFETY_BUFFER) {
      await flattenAsUnsafe(
        position,
        positionRef,
        creds,
        `Liquidation too close to stop-loss: liqDistance=${liqDistance}, ` +
          `slDollars=${slDollars}, bufferUsd=${bufferUsd}, dollarsPerPoint=${dollarsPerPoint}` +
          (settled ? "" : " (balance summary proxy hadn't settled, but the buffer reading itself was available)")
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
    try {
      await closeOpenPosition(position.asset, config, creds);
      await positionRef.update({ liquidationVerified: true });
    } catch (err) {
      // Don't let a failed close (e.g. a Coinbase order rejection) crash
      // this invocation uncaught — log it properly and leave
      // liquidationVerified false so the next minute's tick retries the
      // close instead of the whole check silently disappearing into a
      // generic platform-level error with no application context.
      await logError(
        `liquidationWatcher:${position.asset}`,
        `Emergency flatten close attempt failed, will retry next tick: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  } finally {
    await releaseActionLock();
  }
}
