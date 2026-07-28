import { Timestamp } from "firebase-admin/firestore";
import { db } from "./admin";

// System-wide mutual exclusion around anything that mutates the single open
// position: entries, flattens, kill-switch force-closes, and the several
// scheduled jobs that all independently check the same open position
// (flattenOverduePositions, monitorSessionLoss, watchSimulatedTpSl,
// syncLiveBracketFills — several of which share the exact same "every
// minute" schedule, so Cloud Scheduler can and does invoke them at nearly
// the same instant). Without a shared lock, two of those could race on the
// same close: both read "open", both write an exit trade doc, and both
// apply their own delta to dailyStats.realizedPnl (a read-then-write, not
// atomic), corrupting today's PnL. The lock auto-expires after 60s in case
// a request crashes mid-action without releasing it, so a real failure can
// never permanently block future entries or closes.
const lockRef = db.collection("system").doc("entryLock");

export async function acquireActionLock(): Promise<boolean> {
  return db.runTransaction(async (t) => {
    const snap = await t.get(lockRef);
    const data = snap.exists ? snap.data() : null;
    const lockedAt = data?.lockedAt as Timestamp | undefined;
    const isStale = lockedAt ? Date.now() - lockedAt.toMillis() > 60000 : false;
    if (data?.locked && !isStale) {
      return false;
    }
    t.set(lockRef, { locked: true, lockedAt: Timestamp.now() });
    return true;
  });
}

export async function releaseActionLock(): Promise<void> {
  await lockRef.set({ locked: false }, { merge: true });
}
