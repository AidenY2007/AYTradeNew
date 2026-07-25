import { defineSecret } from "firebase-functions/params";

// Coinbase CDP API key, e.g. "organizations/{org_id}/apiKeys/{key_id}"
export const coinbaseApiKeyName = defineSecret("COINBASE_API_KEY_NAME");
// The EC private key (PEM) that came with the CDP API key
export const coinbaseApiPrivateKey = defineSecret("COINBASE_API_PRIVATE_KEY");
// Shared secret embedded in every TradingView alert_message payload
export const webhookSharedSecret = defineSecret("WEBHOOK_SHARED_SECRET");
// Password for the dashboard login callable
export const dashboardPassword = defineSecret("DASHBOARD_PASSWORD");
