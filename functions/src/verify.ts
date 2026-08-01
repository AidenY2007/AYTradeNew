import { onCall, HttpsError } from "firebase-functions/https";
import { OWNER_UID, ASSETS } from "./admin";
import { coinbaseApiKeyName, coinbaseApiPrivateKey } from "./secrets";
import {
  getBalanceSummary,
  getProduct,
  listProducts,
  getTransactionSummary,
} from "./coinbase/client";

function requireOwner(auth: { uid: string } | undefined) {
  if (!auth || auth.uid !== OWNER_UID) {
    throw new HttpsError("permission-denied", "Not authorized.");
  }
}

// Step-0 sanity check: confirms the Coinbase key can read futures balance
// and all 4 product definitions before anything is wired to place orders.
export const verifyCoinbaseAccess = onCall(
  { secrets: [coinbaseApiKeyName, coinbaseApiPrivateKey] },
  async (request) => {
    requireOwner(request.auth);
    const creds = {
      apiKeyName: coinbaseApiKeyName.value(),
      privateKeyPem: coinbaseApiPrivateKey.value(),
    };

    const results: Record<string, unknown> = {};

    try {
      results.balance = await getBalanceSummary(creds);
    } catch (err) {
      results.balanceError = err instanceof Error ? err.message : String(err);
    }

    try {
      results.transactionSummary = await getTransactionSummary(creds);
    } catch (err) {
      results.transactionSummaryError =
        err instanceof Error ? err.message : String(err);
    }

    for (const asset of ASSETS) {
      try {
        results[`product_${asset}`] = await getProduct(creds, asset);
      } catch (err) {
        results[`product_${asset}_error`] =
          err instanceof Error ? err.message : String(err);
      }
    }

    return results;
  }
);

// One-off helper to discover the real futures product_id strings — needed
// because Coinbase futures IDs include contract/expiry suffixes that can't
// be guessed. Run once, then hardcode the results into PRODUCT_IDS.
export const listFuturesProducts = onCall(
  { secrets: [coinbaseApiKeyName, coinbaseApiPrivateKey] },
  async (request) => {
    requireOwner(request.auth);
    const creds = {
      apiKeyName: coinbaseApiKeyName.value(),
      privateKeyPem: coinbaseApiPrivateKey.value(),
    };
    return listProducts(creds);
  }
);
