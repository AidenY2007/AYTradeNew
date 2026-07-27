import { onCall, HttpsError } from "firebase-functions/https";
import { db, ASSETS, Asset, OWNER_UID } from "./admin";
import {
  coinbaseApiKeyName,
  coinbaseApiPrivateKey,
} from "./secrets";
import { configDocRef, getConfig } from "./config";
import { closeOpenPosition } from "./positionActions";
import { PRODUCT_IDS, getBalanceSummary, getProduct } from "./coinbase/client";

interface SetKillSwitchInput {
  scope: "global" | Asset;
  on: boolean;
}

function requireOwner(auth: { uid: string } | undefined) {
  if (!auth || auth.uid !== OWNER_UID) {
    throw new HttpsError("permission-denied", "Not authorized.");
  }
}

export const setKillSwitch = onCall<SetKillSwitchInput>(
  { secrets: [coinbaseApiKeyName, coinbaseApiPrivateKey] },
  async (request) => {
    requireOwner(request.auth);
    const { scope, on } = request.data;

    if (scope !== "global" && !ASSETS.includes(scope)) {
      throw new HttpsError("invalid-argument", "Invalid scope.");
    }

    if (scope === "global") {
      // Global is a true master switch: flipping it sets every asset to
      // match, in both directions.
      const assetUpdates = Object.fromEntries(
        ASSETS.map((asset) => [asset, on])
      ) as Record<Asset, boolean>;
      await configDocRef().set(
        { globalKillSwitch: on, assetKillSwitches: assetUpdates },
        { merge: true }
      );
      if (!on) {
        // The session-loss trip (positionActions.ts / sessionLossMonitor.ts)
        // sets dailyStats.killSwitchTriggered independently of
        // config.globalKillSwitch, and webhook.ts blocks new entries on that
        // flag directly. Without clearing it here too, manually turning the
        // dashboard switch back off would look like it worked while entries
        // stayed silently blocked until the next midnight-ET reset.
        const key = new Intl.DateTimeFormat("en-CA", {
          timeZone: "America/New_York",
        }).format(new Date());
        await db
          .collection("dailyStats")
          .doc(key)
          .set({ killSwitchTriggered: false }, { merge: true });
      }
    } else {
      const current = await getConfig();
      const updatedAssetSwitches = {
        ...current.assetKillSwitches,
        [scope]: on,
      };
      const patch: Record<string, unknown> = {
        assetKillSwitches: { [scope]: on },
      };
      if (!on) {
        // Turning any single asset off means "all assets killed" is no
        // longer true, so global follows it off.
        patch.globalKillSwitch = false;
      } else if (ASSETS.every((asset) => updatedAssetSwitches[asset])) {
        // Turning the last remaining asset on completes the set, so
        // global follows it on.
        patch.globalKillSwitch = true;
      }
      await configDocRef().set(patch, { merge: true });
    }

    if (on) {
      const config = await getConfig();
      const creds = {
        apiKeyName: coinbaseApiKeyName.value(),
        privateKeyPem: coinbaseApiPrivateKey.value(),
      };
      const assetsToClose = scope === "global" ? ASSETS : [scope];
      for (const asset of assetsToClose) {
        await closeOpenPosition(asset, config, creds);
      }
    }

    return { ok: true };
  }
);

// Polled periodically by the dashboard (not on every tick) — balance and
// per-asset market-session status both require live Coinbase calls, so this
// is intentionally not part of the 1-second UI clock.
export const getSystemState = onCall(
  { secrets: [coinbaseApiKeyName, coinbaseApiPrivateKey] },
  async (request) => {
    requireOwner(request.auth);
    const config = await getConfig();
    const openSnap = await db
      .collection("positions")
      .where("status", "==", "open")
      .limit(1)
      .get();

    const creds = {
      apiKeyName: coinbaseApiKeyName.value(),
      privateKeyPem: coinbaseApiPrivateKey.value(),
    };

    let balance = null;
    try {
      balance = await getBalanceSummary(creds);
    } catch {
      // Leave null — dashboard shows a placeholder rather than erroring.
    }

    const sessionOpen: Record<Asset, boolean> = {} as Record<Asset, boolean>;
    const prices: Record<Asset, number | null> = {} as Record<
      Asset,
      number | null
    >;
    await Promise.all(
      ASSETS.map(async (asset) => {
        try {
          const product = await getProduct(creds, PRODUCT_IDS[asset]);
          sessionOpen[asset] = product.isSessionOpen;
          prices[asset] = product.price;
        } catch {
          sessionOpen[asset] = true;
          prices[asset] = null;
        }
      })
    );

    const openPositionAsset = openSnap.empty
      ? null
      : (openSnap.docs[0].data().asset as Asset);

    return {
      config,
      openPosition: openSnap.empty
        ? null
        : { id: openSnap.docs[0].id, ...openSnap.docs[0].data() },
      markPrice: openPositionAsset ? prices[openPositionAsset] : null,
      balance,
      sessionOpen,
    };
  }
);
