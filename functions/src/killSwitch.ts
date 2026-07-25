import { onCall, HttpsError } from "firebase-functions/https";
import { db, ASSETS, Asset, OWNER_UID } from "./admin";
import {
  coinbaseApiKeyName,
  coinbaseApiPrivateKey,
} from "./secrets";
import { configDocRef, getConfig } from "./config";
import { closeOpenPosition } from "./positionActions";

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
      await configDocRef().set({ globalKillSwitch: on }, { merge: true });
    } else {
      await configDocRef().set(
        { assetKillSwitches: { [scope]: on } },
        { merge: true }
      );
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

export const getSystemState = onCall(async (request) => {
  requireOwner(request.auth);
  const config = await getConfig();
  const openSnap = await db
    .collection("positions")
    .where("status", "==", "open")
    .limit(1)
    .get();
  return {
    config,
    openPosition: openSnap.empty
      ? null
      : { id: openSnap.docs[0].id, ...openSnap.docs[0].data() },
  };
});
