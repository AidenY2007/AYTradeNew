import { httpsCallable } from "firebase/functions";
import { functions } from "./firebase";
import type { AssetTradingWindow } from "./types";

export function setKillSwitch(scope: string, on: boolean) {
  return httpsCallable(functions, "setKillSwitch")({ scope, on });
}

export function setLiveMode(liveMode: boolean) {
  return httpsCallable(functions, "setLiveMode")({ liveMode });
}

export function setSessionLossLimit(amount: number) {
  return httpsCallable(functions, "setSessionLossLimit")({ amount });
}

export function setTradableBalance(amount: number) {
  return httpsCallable(functions, "setTradableBalance")({ amount });
}

export function setTradingWindow(asset: string, window: AssetTradingWindow) {
  return httpsCallable(functions, "setTradingWindow")({ asset, window });
}

export function resetTradingWindowsToDefault() {
  return httpsCallable(functions, "resetTradingWindowsToDefault")({});
}

export function setFeePerContract(asset: string, amount: number) {
  return httpsCallable(functions, "setFeePerContract")({ asset, amount });
}

export function verifyCoinbaseAccess() {
  return httpsCallable(functions, "verifyCoinbaseAccess")({});
}

export function listFuturesProducts() {
  return httpsCallable(functions, "listFuturesProducts")({});
}

export interface SystemState {
  balance: { futuresBuyingPower: number; totalUsdBalance: number } | null;
  sessionOpen: Record<string, boolean> | null;
  markPrice: number | null;
}

export function getSystemState() {
  return httpsCallable<Record<string, never>, SystemState>(
    functions,
    "getSystemState"
  )({});
}

export function testLiveShortEntry() {
  return httpsCallable(functions, "testLiveShortEntry")({});
}

export function testLiveLongEntry() {
  return httpsCallable(functions, "testLiveLongEntry")({});
}

export function closeTestPosition() {
  return httpsCallable(functions, "closeTestPosition")({});
}
