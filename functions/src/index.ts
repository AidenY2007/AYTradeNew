import { setGlobalOptions } from "firebase-functions";

setGlobalOptions({ maxInstances: 10 });

export { webhook } from "./webhook";
export { setKillSwitch, getSystemState } from "./killSwitch";
export { resetDailyStats } from "./dailyLoss";
export { flattenOverduePositions } from "./flattenScheduler";
export { monitorSessionLoss } from "./sessionLossMonitor";
export { watchSimulatedTpSl } from "./simulatedTpSlWatcher";
export { watchLiquidationSafety } from "./liquidationWatcher";
export { syncLiveBracketFills } from "./liveBracketSync";
export { login } from "./auth";
export {
  setSessionLossLimit,
  setLiveMode,
  setTradingWindow,
  setFeePerContract,
  setTradableBalance,
  resetTradingWindowsToDefault,
} from "./settings";
export { verifyCoinbaseAccess, listFuturesProducts } from "./verify";
export { testLiveShortEntry, testLiveLongEntry, closeTestPosition } from "./testTrade";
