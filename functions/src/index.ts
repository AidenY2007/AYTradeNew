import { setGlobalOptions } from "firebase-functions";

setGlobalOptions({ maxInstances: 10 });

export { webhook } from "./webhook";
export { setKillSwitch, getSystemState } from "./killSwitch";
export { resetDailyStats } from "./dailyLoss";
export { flattenOverduePositions } from "./flattenScheduler";
export { login } from "./auth";
export {
  setDailyLossPct,
  setLiveMode,
  setTradingWindow,
  setFeePerContract,
  resetTradingWindowsToDefault,
} from "./settings";
export { verifyCoinbaseAccess, listFuturesProducts } from "./verify";
export { testLiveShortEntry, closeTestPosition } from "./testTrade";
