import { db, ASSETS } from "./admin";
import { SystemConfig, AssetTradingWindow } from "./types";

const mins = (h: number, m: number) => h * 60 + m;

// Mirrors each Pine script's current default input values.
// Editable later from the dashboard Settings page if the Pine inputs change.
const DEFAULT_WINDOWS: Record<string, AssetTradingWindow> = {
  btc: {
    entryStartMins: mins(0, 0),
    entryCutoffMins: mins(13, 30),
    flattenMins: mins(15, 30),
    cooldownHours: 4,
    weekendBlocked: true,
  },
  tech: {
    entryStartMins: mins(0, 0),
    entryCutoffMins: mins(13, 30),
    flattenMins: mins(15, 30),
    cooldownHours: 4,
    weekendBlocked: true,
  },
  ai: {
    entryStartMins: mins(0, 0),
    entryCutoffMins: mins(13, 30),
    flattenMins: mins(15, 30),
    cooldownHours: 4,
    weekendBlocked: true,
  },
  china: {
    entryStartMins: mins(0, 0),
    entryCutoffMins: mins(12, 0),
    flattenMins: mins(15, 30),
    cooldownHours: 4,
    weekendBlocked: true,
  },
};

// Round-trip commission per contract, given directly by the user (Coinbase
// futures charge a flat per-contract fee, not a percentage of notional, and
// it's not reliably queryable via the API for these CDE products).
const DEFAULT_FEES_PER_CONTRACT: Record<string, number> = {
  btc: 1.6,
  tech: 7.8,
  china: 6.3,
  ai: 5.7,
};

export const DEFAULT_CONFIG: SystemConfig = {
  globalKillSwitch: false,
  assetKillSwitches: { btc: false, tech: false, ai: false, china: false },
  sessionLossLimitDollars: 400,
  liveMode: false,
  tradingWindow: DEFAULT_WINDOWS as SystemConfig["tradingWindow"],
  feesPerContract: DEFAULT_FEES_PER_CONTRACT as SystemConfig["feesPerContract"],
};

const CONFIG_DOC = db.collection("system").doc("config");

export async function getConfig(): Promise<SystemConfig> {
  const snap = await CONFIG_DOC.get();
  if (!snap.exists) {
    await CONFIG_DOC.set(DEFAULT_CONFIG);
    return DEFAULT_CONFIG;
  }
  const data = snap.data() as SystemConfig;
  // Self-heal: backfill any top-level keys added after this config doc was
  // first created (e.g. feesPerContract), so older docs don't need a manual
  // migration step.
  const missing = Object.keys(DEFAULT_CONFIG).filter((key) => !(key in data));
  if (missing.length > 0) {
    const patch: Record<string, unknown> = {};
    for (const key of missing) {
      patch[key] = (DEFAULT_CONFIG as unknown as Record<string, unknown>)[key];
    }
    await CONFIG_DOC.set(patch, { merge: true });
    return { ...data, ...patch } as SystemConfig;
  }
  return data;
}

export function configDocRef() {
  return CONFIG_DOC;
}

export { ASSETS };
