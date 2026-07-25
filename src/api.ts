import { httpsCallable } from "firebase/functions";
import { functions } from "./firebase";
import type { AssetTradingWindow } from "./types";

export function setKillSwitch(scope: string, on: boolean) {
  return httpsCallable(functions, "setKillSwitch")({ scope, on });
}

export function setLiveMode(liveMode: boolean) {
  return httpsCallable(functions, "setLiveMode")({ liveMode });
}

export function setDailyLossPct(pct: number) {
  return httpsCallable(functions, "setDailyLossPct")({ pct });
}

export function setTradingWindow(asset: string, window: AssetTradingWindow) {
  return httpsCallable(functions, "setTradingWindow")({ asset, window });
}

export function resetTradingWindowsToDefault() {
  return httpsCallable(functions, "resetTradingWindowsToDefault")({});
}

export function verifyCoinbaseAccess() {
  return httpsCallable(functions, "verifyCoinbaseAccess")({});
}

export function listFuturesProducts() {
  return httpsCallable(functions, "listFuturesProducts")({});
}
