import { onSchedule } from "firebase-functions/scheduler";
import { db } from "./admin";
import { coinbaseApiKeyName, coinbaseApiPrivateKey } from "./secrets";
import { getBalanceSummary } from "./coinbase/client";

function todayKey(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
  }).format(new Date());
}

// Snapshots the day's starting balance at midnight ET so the daily-loss %
// kill switch has an accurate baseline even before any trade closes today.
export const resetDailyStats = onSchedule(
  {
    schedule: "0 0 * * *",
    timeZone: "America/New_York",
    secrets: [coinbaseApiKeyName, coinbaseApiPrivateKey],
  },
  async () => {
    const creds = {
      apiKeyName: coinbaseApiKeyName.value(),
      privateKeyPem: coinbaseApiPrivateKey.value(),
    };
    const balanceSummary = await getBalanceSummary(creds).catch(() => null);
    await db
      .collection("dailyStats")
      .doc(todayKey())
      .set(
        {
          balanceStart: balanceSummary?.totalUsdBalance ?? 0,
          realizedPnl: 0,
          killSwitchTriggered: false,
        },
        { merge: true }
      );
  }
);
