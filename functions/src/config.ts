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
  // Unlike every other strategy, btc4h is meant to hold positions overnight
  // and through weekends — always allowed to enter except when a position is
  // already open (the shared global lock) or during the Friday Coinbase
  // maintenance window (checked separately in webhook.ts, not part of this
  // window). entryCutoffMins: 1439 and flattenMins: 1440 are both
  // deliberately unreachable (minsET never exceeds 1439), so the daily
  // flatten scheduler leaves it alone.
  btc4h: {
    entryStartMins: mins(0, 0),
    entryCutoffMins: 1439,
    flattenMins: 1440,
    cooldownHours: 0,
    weekendBlocked: false,
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
  btc4h: 1.42,
};

export const DEFAULT_CONFIG: SystemConfig = {
  globalKillSwitch: false,
  assetKillSwitches: {
    btc: false,
    tech: false,
    ai: false,
    china: false,
    btc4h: false,
  },
  sessionLossLimitDollars: 400,
  liveMode: false,
  tradingWindow: DEFAULT_WINDOWS as SystemConfig["tradingWindow"],
  feesPerContract: DEFAULT_FEES_PER_CONTRACT as SystemConfig["feesPerContract"],
  // Deliberately high default so this never silently caps anyone below their
  // real buying power until they actually set it from Settings.
  tradableBalanceDollars: 1_000_000,
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
  const patch: Record<string, unknown> = {};
  for (const key of missing) {
    patch[key] = (DEFAULT_CONFIG as unknown as Record<string, unknown>)[key];
  }

  // Also self-heal missing *per-asset* entries inside maps that already
  // exist — adding a new asset (e.g. btc4h) doesn't add a missing top-level
  // key above, since tradingWindow/feesPerContract/assetKillSwitches already
  // exist on the doc, just without the new asset's entry yet.
  const perAssetMaps: Array<keyof SystemConfig> = [
    "tradingWindow",
    "feesPerContract",
    "assetKillSwitches",
  ];
  for (const mapKey of perAssetMaps) {
    if (missing.includes(mapKey)) continue; // already fully backfilled above
    const existingMap = data[mapKey] as Record<string, unknown>;
    const defaultMap = DEFAULT_CONFIG[mapKey] as Record<string, unknown>;
    const missingAssets = ASSETS.filter((asset) => !(asset in existingMap));
    if (missingAssets.length > 0) {
      const mapPatch: Record<string, unknown> = {};
      for (const asset of missingAssets) {
        mapPatch[asset] = defaultMap[asset];
      }
      patch[mapKey] = mapPatch;
    }
  }

  if (Object.keys(patch).length > 0) {
    await CONFIG_DOC.set(patch, { merge: true });
    const merged = { ...data } as Record<string, unknown>;
    for (const [key, value] of Object.entries(patch)) {
      merged[key] =
        typeof value === "object" && value !== null && !Array.isArray(value)
          ? { ...(merged[key] as Record<string, unknown>), ...value }
          : value;
    }
    return merged as unknown as SystemConfig;
  }
  return data;
}

export function configDocRef() {
  return CONFIG_DOC;
}

export { ASSETS };
