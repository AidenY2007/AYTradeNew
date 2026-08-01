import { onCall, HttpsError } from "firebase-functions/https";
import { OWNER_UID, ASSETS, Asset } from "./admin";
import { configDocRef, DEFAULT_CONFIG } from "./config";
import { AssetTradingWindow } from "./types";

function requireOwner(auth: { uid: string } | undefined) {
  if (!auth || auth.uid !== OWNER_UID) {
    throw new HttpsError("permission-denied", "Not authorized.");
  }
}

interface SetSessionLossLimitInput {
  amount: number;
}

export const setSessionLossLimit = onCall<SetSessionLossLimitInput>(
  async (request) => {
    requireOwner(request.auth);
    const { amount } = request.data;
    if (typeof amount !== "number" || amount <= 0) {
      throw new HttpsError("invalid-argument", "amount must be > 0.");
    }
    await configDocRef().set(
      { sessionLossLimitDollars: amount },
      { merge: true }
    );
    return { ok: true };
  }
);

interface SetTradableBalanceInput {
  amount: number;
}

// Every asset's entry sizes off whichever is lower: this cap or Coinbase's
// actual reported futures buying power (see webhook.ts) — so growth in real
// account balance never silently increases position size beyond this.
export const setTradableBalance = onCall<SetTradableBalanceInput>(
  async (request) => {
    requireOwner(request.auth);
    const { amount } = request.data;
    if (typeof amount !== "number" || amount <= 0) {
      throw new HttpsError("invalid-argument", "amount must be > 0.");
    }
    await configDocRef().set(
      { tradableBalanceDollars: amount },
      { merge: true }
    );
    return { ok: true };
  }
);

interface SetLiveModeInput {
  liveMode: boolean;
}

export const setLiveMode = onCall<SetLiveModeInput>(async (request) => {
  requireOwner(request.auth);
  const { liveMode } = request.data;
  if (typeof liveMode !== "boolean") {
    throw new HttpsError("invalid-argument", "liveMode must be boolean.");
  }
  await configDocRef().set({ liveMode }, { merge: true });
  return { ok: true };
});

interface SetTradingWindowInput {
  asset: Asset;
  window: AssetTradingWindow;
}

export const setTradingWindow = onCall<SetTradingWindowInput>(
  async (request) => {
    requireOwner(request.auth);
    const { asset, window } = request.data;
    if (!ASSETS.includes(asset)) {
      throw new HttpsError("invalid-argument", "Invalid asset.");
    }
    const required: (keyof AssetTradingWindow)[] = [
      "entryStartMins",
      "entryCutoffMins",
      "flattenMins",
      "cooldownHours",
      "weekendBlocked",
    ];
    for (const key of required) {
      if (window[key] === undefined) {
        throw new HttpsError("invalid-argument", `Missing ${key}.`);
      }
    }
    await configDocRef().set(
      { tradingWindow: { [asset]: window } },
      { merge: true }
    );
    return { ok: true };
  }
);

interface SetFeePerContractInput {
  asset: Asset;
  amount: number;
}

// Updates the round-trip per-contract fee for one asset. Only affects
// positions entered after this change — each position snapshots the rate
// in effect at entry time, so past positions' recorded PnL never changes.
export const setFeePerContract = onCall<SetFeePerContractInput>(
  async (request) => {
    requireOwner(request.auth);
    const { asset, amount } = request.data;
    if (!ASSETS.includes(asset)) {
      throw new HttpsError("invalid-argument", "Invalid asset.");
    }
    if (typeof amount !== "number" || amount < 0) {
      throw new HttpsError("invalid-argument", "amount must be >= 0.");
    }
    await configDocRef().set(
      { feesPerContract: { [asset]: amount } },
      { merge: true }
    );
    return { ok: true };
  }
);

// Resets every asset's trading window back to the values hardcoded in
// config.ts (which mirror each Pine script's current default inputs) —
// a single verifiable revert after any temporary manual test changes,
// rather than relying on typing values back in by hand.
export const resetTradingWindowsToDefault = onCall(async (request) => {
  requireOwner(request.auth);
  await configDocRef().set(
    { tradingWindow: DEFAULT_CONFIG.tradingWindow },
    { merge: true }
  );
  return { ok: true, tradingWindow: DEFAULT_CONFIG.tradingWindow };
});
