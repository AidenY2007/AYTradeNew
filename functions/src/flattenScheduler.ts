import { onSchedule } from "firebase-functions/scheduler";
import { db } from "./admin";
import { coinbaseApiKeyName, coinbaseApiPrivateKey } from "./secrets";
import { getConfig } from "./config";
import { isPastFlattenTime } from "./tradingWindow";
import { closeOpenPosition } from "./positionActions";
import { acquireActionLock, releaseActionLock } from "./lock";
import { PositionDoc } from "./types";

// Independent backstop for the "never hold overnight" rule: runs every
// minute and force-closes any open position once its asset's flatten time
// has passed, regardless of whether Pine's own close_all alert ever fires.
export const flattenOverduePositions = onSchedule(
  {
    schedule: "* * * * *",
    timeZone: "America/New_York",
    secrets: [coinbaseApiKeyName, coinbaseApiPrivateKey],
  },
  async () => {
    const config = await getConfig();
    const openSnap = await db
      .collection("positions")
      .where("status", "==", "open")
      .get();
    if (openSnap.empty) return;

    const creds = {
      apiKeyName: coinbaseApiKeyName.value(),
      privateKeyPem: coinbaseApiPrivateKey.value(),
    };

    // Shared with every other close-touching path (webhook flatten, kill
    // switches, session-loss monitor, bracket-fill sync) — several of which
    // run on this exact same every-minute schedule, so without this lock
    // two of them could race on the same open position and double-write
    // its close. If it's busy, skip this run; next minute's tick will
    // catch it if still overdue.
    const acquired = await acquireActionLock();
    if (!acquired) return;
    try {
      for (const doc of openSnap.docs) {
        const position = doc.data() as PositionDoc;
        const window = config.tradingWindow[position.asset];
        if (isPastFlattenTime(window)) {
          await closeOpenPosition(position.asset, config, creds);
        }
      }
    } finally {
      await releaseActionLock();
    }
  }
);
