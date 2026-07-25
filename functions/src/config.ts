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

export const DEFAULT_CONFIG: SystemConfig = {
  globalKillSwitch: false,
  assetKillSwitches: { btc: false, tech: false, ai: false, china: false },
  dailyLossKillSwitchPct: 40,
  liveMode: false,
  tradingWindow: DEFAULT_WINDOWS as SystemConfig["tradingWindow"],
};

const CONFIG_DOC = db.collection("system").doc("config");

export async function getConfig(): Promise<SystemConfig> {
  const snap = await CONFIG_DOC.get();
  if (!snap.exists) {
    await CONFIG_DOC.set(DEFAULT_CONFIG);
    return DEFAULT_CONFIG;
  }
  return snap.data() as SystemConfig;
}

export function configDocRef() {
  return CONFIG_DOC;
}

export { ASSETS };
