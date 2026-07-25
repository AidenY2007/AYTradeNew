import { setGlobalOptions } from "firebase-functions";

setGlobalOptions({ maxInstances: 10 });

export { webhook } from "./webhook";
export { setKillSwitch, getSystemState } from "./killSwitch";
export { resetDailyStats } from "./dailyLoss";
export { login } from "./auth";
export {
  setDailyLossPct,
  setLiveMode,
  setTradingWindow,
  resetTradingWindowsToDefault,
} from "./settings";
export { verifyCoinbaseAccess, listFuturesProducts } from "./verify";
