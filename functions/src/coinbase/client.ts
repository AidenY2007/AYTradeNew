import * as crypto from "crypto";
import { Asset } from "../admin";

const API_HOST = "api.coinbase.com";
const BASE_URL = `https://${API_HOST}`;

// Coinbase Advanced Perpetuals product IDs, confirmed via
// GET /api/v3/brokerage/products?product_type=FUTURE against the live account.
export const PRODUCT_IDS: Record<Asset, string> = {
  btc: "BIP-20DEC30-CDE",
  tech: "TEK-19DEC30-CDE",
  ai: "AIP-19DEC30-CDE",
  china: "CHN-19DEC30-CDE",
  // Same underlying Coinbase product as "btc" — btc4h is a second strategy
  // trading the same BTC nano perp on a different timeframe, not a distinct
  // instrument.
  btc4h: "BIP-20DEC30-CDE",
};

// Fixed contract multiplier per product — BTC's nano contract is 0.01 BTC,
// the equity-index perps (Tech/AI/China) are 1:1. Confirmed facts about these
// listings, not something derivable from account state. Hardcoded rather
// than trusted from Coinbase's API response, since a missing/wrong field
// there would otherwise silently corrupt PnL with no visible error.
export const CONTRACT_SIZE: Record<Asset, number> = {
  btc: 0.01,
  tech: 1,
  ai: 1,
  china: 1,
  btc4h: 0.01,
};

// btc4h holds positions overnight/through weekends, so sizing must use
// Coinbase's real overnight margin rate, not the higher intraday rate this
// account otherwise qualifies for — a position sized at the intraday rate
// would end up under-margined the instant overnight rules apply. Used by
// maxOvernightLeverageForSide() below; only as a last resort if that rate is
// ever missing from Coinbase's response (confirmed against Coinbase's own
// order form as of when this was added).
export const FALLBACK_OVERNIGHT_LEVERAGE = 4.1;

// Extra safety margin on top of Coinbase's own reported overnight rate —
// guards against the rate shifting slightly between when a position is
// sized and when overnight margin rules actually take effect.
const OVERNIGHT_LEVERAGE_HAIRCUT = 0.9;

export interface CoinbaseCredentials {
  apiKeyName: string;
  // Either a PEM-encoded EC private key (legacy CDP keys, starts with
  // "-----BEGIN EC PRIVATE KEY-----") or a base64 Ed25519 secret (current
  // default CDP key type — a 64-byte base64 string with no PEM markers).
  privateKeyPem: string;
}

// RFC 8410 PKCS8 wrapper prefix for a raw 32-byte Ed25519 seed.
const ED25519_PKCS8_PREFIX = Buffer.from(
  "302e020100300506032b657004220420",
  "hex"
);

function signingKeyFor(secret: string): {
  key: string | crypto.KeyObject;
  algorithm: "ES256" | "EdDSA";
} {
  if (secret.includes("BEGIN")) {
    return { key: secret, algorithm: "ES256" };
  }
  // CDP Ed25519 secrets are base64(32-byte seed || 32-byte public key).
  const raw = Buffer.from(secret, "base64");
  const seed = raw.subarray(0, 32);
  const der = Buffer.concat([ED25519_PKCS8_PREFIX, seed]);
  const key = crypto.createPrivateKey({
    key: der,
    format: "der",
    type: "pkcs8",
  });
  return { key, algorithm: "EdDSA" };
}

function base64url(input: Buffer): string {
  return input
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function buildJwt(
  creds: CoinbaseCredentials,
  method: string,
  path: string
): string {
  const uri = `${method} ${API_HOST}${path}`;
  const now = Math.floor(Date.now() / 1000);
  const { key, algorithm } = signingKeyFor(creds.privateKeyPem);

  const header = base64url(
    Buffer.from(
      JSON.stringify({
        alg: algorithm,
        kid: creds.apiKeyName,
        typ: "JWT",
        nonce: crypto.randomBytes(16).toString("hex"),
      })
    )
  );
  const payload = base64url(
    Buffer.from(
      JSON.stringify({
        sub: creds.apiKeyName,
        iss: "cdp",
        nbf: now,
        exp: now + 120,
        uri,
      })
    )
  );
  const signingInput = `${header}.${payload}`;

  const signature =
    algorithm === "ES256"
      ? crypto.sign("sha256", Buffer.from(signingInput), {
          key: key as string,
          dsaEncoding: "ieee-p1363",
        })
      : crypto.sign(null, Buffer.from(signingInput), key as crypto.KeyObject);

  return `${signingInput}.${base64url(signature)}`;
}

async function request<T>(
  creds: CoinbaseCredentials,
  method: "GET" | "POST",
  path: string,
  body?: unknown
): Promise<T> {
  // The JWT's uri claim must be just the path, no query string.
  const pathOnly = path.split("?")[0];
  const token = buildJwt(creds, method, pathOnly);
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) {
    throw new Error(
      `Coinbase API ${method} ${path} failed: ${res.status} ${text}`
    );
  }
  return json as T;
}

export interface BalanceSummary {
  futuresBuyingPower: number;
  totalUsdBalance: number;
  // Dollar buffer above the liquidation threshold, computed under overnight
  // margin rules specifically (Coinbase's own `overnight_margin_window_measure
  // .liquidation_buffer`) — checked even during intraday hours, since it
  // reflects the stricter requirement a held-overnight position will face
  // regardless of what time it was entered. null if the field is missing
  // from the response, never a guessed number.
  overnightLiquidationBufferUsd: number | null;
  raw: unknown;
}

export async function getBalanceSummary(
  creds: CoinbaseCredentials
): Promise<BalanceSummary> {
  const json = await request<any>(
    creds,
    "GET",
    "/api/v3/brokerage/cfm/balance_summary"
  );
  const summary = json.balance_summary ?? {};
  const overnightBuffer =
    summary.overnight_margin_window_measure?.liquidation_buffer?.value ??
    summary.overnight_margin_window_measure?.liquidation_buffer;
  const overnightBufferNum = Number(overnightBuffer);
  return {
    futuresBuyingPower: Number(
      summary.futures_buying_power?.value ?? summary.cfm_usd_balance?.value ?? 0
    ),
    totalUsdBalance: Number(
      summary.total_usd_balance?.value ?? summary.cfm_usd_balance?.value ?? 0
    ),
    overnightLiquidationBufferUsd: Number.isFinite(overnightBufferNum)
      ? overnightBufferNum
      : null,
    raw: json,
  };
}

export interface ProductSummary {
  productId: string;
  displayName: string;
  productType: string;
  status: string;
}

// Lists all products so we can find the real product_id strings for the 4
// futures products — Coinbase futures IDs include expiry/contract suffixes
// that aren't guessable ahead of time.
export async function listProducts(
  creds: CoinbaseCredentials
): Promise<ProductSummary[]> {
  const json = await request<any>(
    creds,
    "GET",
    "/api/v3/brokerage/products?product_type=FUTURE&limit=250"
  );
  const products = json.products ?? [];
  return products.map((p: any) => ({
    productId: p.product_id,
    displayName: p.display_name ?? p.product_id,
    productType: p.product_type,
    status: p.status,
  }));
}

export interface ProductInfo {
  productId: string;
  price: number;
  baseIncrement: number;
  quoteIncrement: number;
  // Notional value of one contract in the underlying's own units. Always
  // 0.01 for our 4 products — see CONTRACT_SIZE.
  contractSize: number;
  // Fraction of notional required as margin, intraday — leverage = 1/rate.
  // Long/short rates differ slightly, so both are kept and picked by side.
  intradayLongMarginRate: number;
  intradayShortMarginRate: number;
  // Same shape as above but for the stricter overnight/weekend requirement —
  // null if Coinbase's response doesn't include it (see
  // maxOvernightLeverageForSide()'s fallback).
  overnightLongMarginRate: number | null;
  overnightShortMarginRate: number | null;
  // Equity-index perps (Tech/AI/China) trade real market hours, not 24/7 —
  // must be checked before every order, separately from our own time rules.
  isSessionOpen: boolean;
  raw: unknown;
}

export async function getProduct(
  creds: CoinbaseCredentials,
  asset: Asset
): Promise<ProductInfo> {
  const productId = PRODUCT_IDS[asset];
  const json = await request<any>(
    creds,
    "GET",
    `/api/v3/brokerage/products/${productId}`
  );
  const futureDetails = json.future_product_details ?? {};
  return {
    productId,
    price: Number(json.price),
    baseIncrement: Number(json.base_increment),
    quoteIncrement: Number(json.quote_increment),
    contractSize: CONTRACT_SIZE[asset],
    intradayLongMarginRate: Number(
      futureDetails.intraday_margin_rate?.long_margin_rate ?? 1
    ),
    intradayShortMarginRate: Number(
      futureDetails.intraday_margin_rate?.short_margin_rate ?? 1
    ),
    overnightLongMarginRate:
      futureDetails.overnight_margin_rate?.long_margin_rate != null
        ? Number(futureDetails.overnight_margin_rate.long_margin_rate)
        : null,
    overnightShortMarginRate:
      futureDetails.overnight_margin_rate?.short_margin_rate != null
        ? Number(futureDetails.overnight_margin_rate.short_margin_rate)
        : null,
    isSessionOpen: Boolean(json.fcm_trading_session_details?.is_session_open),
    raw: json,
  };
}

export function maxLeverageForSide(
  product: ProductInfo,
  side: "long" | "short"
): number {
  const marginRate =
    side === "long"
      ? product.intradayLongMarginRate
      : product.intradayShortMarginRate;
  return marginRate > 0 ? 1 / marginRate : 1;
}

// btc4h-only: sizes off Coinbase's real overnight margin rate (fetched
// live), with a haircut on top as a buffer against the rate shifting
// slightly between sizing and when overnight rules actually apply. Falls
// back to the hardcoded FALLBACK_OVERNIGHT_LEVERAGE only if Coinbase's
// response is ever missing this field.
export function maxOvernightLeverageForSide(
  product: ProductInfo,
  side: "long" | "short"
): number {
  const marginRate =
    side === "long"
      ? product.overnightLongMarginRate
      : product.overnightShortMarginRate;
  if (marginRate == null || marginRate <= 0) {
    return FALLBACK_OVERNIGHT_LEVERAGE;
  }
  return (1 / marginRate) * OVERNIGHT_LEVERAGE_HAIRCUT;
}

export interface OrderResult {
  orderId: string;
  raw: unknown;
}

export async function placeMarketOrder(
  creds: CoinbaseCredentials,
  productId: string,
  side: "BUY" | "SELL",
  baseSize: string
): Promise<OrderResult> {
  const clientOrderId = crypto.randomUUID();
  const json = await request<any>(creds, "POST", "/api/v3/brokerage/orders", {
    client_order_id: clientOrderId,
    product_id: productId,
    side,
    order_configuration: {
      market_market_ioc: { base_size: baseSize },
    },
  });
  if (json.success === false) {
    throw new Error(`Order rejected: ${JSON.stringify(json.error_response)}`);
  }
  return { orderId: json.success_response?.order_id ?? clientOrderId, raw: json };
}

// Attached TP/SL as a bracket order: places the opposite-side conditional
// order that closes the position when either level is hit (exchange-side
// OCO — only one leg executes).
export async function placeBracketOrder(
  creds: CoinbaseCredentials,
  productId: string,
  closingSide: "BUY" | "SELL",
  baseSize: string,
  takeProfitPrice: string,
  stopLossPrice: string
): Promise<OrderResult> {
  const clientOrderId = crypto.randomUUID();
  const json = await request<any>(creds, "POST", "/api/v3/brokerage/orders", {
    client_order_id: clientOrderId,
    product_id: productId,
    side: closingSide,
    order_configuration: {
      trigger_bracket_gtc: {
        base_size: baseSize,
        limit_price: takeProfitPrice,
        stop_trigger_price: stopLossPrice,
      },
    },
  });
  if (json.success === false) {
    throw new Error(
      `Bracket order rejected: ${JSON.stringify(json.error_response)}`
    );
  }
  return { orderId: json.success_response?.order_id ?? clientOrderId, raw: json };
}

export interface OrderFill {
  avgFilledPrice: number | null;
  filledSize: number | null;
  status: string;
  raw: unknown;
}

export async function getOrder(
  creds: CoinbaseCredentials,
  orderId: string
): Promise<OrderFill> {
  const json = await request<any>(
    creds,
    "GET",
    `/api/v3/brokerage/orders/historical/${orderId}`
  );
  const order = json.order ?? {};
  // "0" is a valid non-empty string and therefore truthy — a naive truthy
  // check here treats "not filled yet" as "filled at price 0". Parse first,
  // then treat a non-positive result as not-yet-available.
  const parsedPrice = order.average_filled_price
    ? Number(order.average_filled_price)
    : NaN;
  const parsedSize = order.filled_size ? Number(order.filled_size) : NaN;
  return {
    avgFilledPrice: parsedPrice > 0 ? parsedPrice : null,
    filledSize: parsedSize > 0 ? parsedSize : null,
    status: order.status,
    raw: json,
  };
}

// Market orders usually fill within milliseconds, but the historical-order
// endpoint doesn't always reflect the fill the instant the order call
// returns. Poll briefly rather than trusting a single immediate read.
export async function waitForFill(
  creds: CoinbaseCredentials,
  orderId: string,
  maxAttempts = 6,
  delayMs = 500
): Promise<OrderFill> {
  let lastFill: OrderFill = {
    avgFilledPrice: null,
    filledSize: null,
    status: "UNKNOWN",
    raw: null,
  };
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    lastFill = await getOrder(creds, orderId);
    if (lastFill.status === "FILLED" && lastFill.avgFilledPrice != null) {
      return lastFill;
    }
    if (attempt < maxAttempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return lastFill;
}

// Returns whether Coinbase actually confirmed the cancel — false both for a
// real API failure and for "order no longer cancelable" (already filled or
// already canceled). Callers that go on to place a replacement order must
// check this rather than assume success, or a failed cancel could leave two
// live orders resting at once.
export async function cancelOrder(
  creds: CoinbaseCredentials,
  orderId: string
): Promise<boolean> {
  const json = await request<any>(
    creds,
    "POST",
    "/api/v3/brokerage/orders/batch_cancel",
    { order_ids: [orderId] }
  );
  const result = (json.results ?? []).find((r: any) => r?.order_id === orderId);
  return Boolean(result?.success);
}

export async function getOpenPositions(
  creds: CoinbaseCredentials
): Promise<unknown> {
  return request(creds, "GET", "/api/v3/brokerage/cfm/positions");
}

// One-off diagnostic: this is a percentage-of-notional fee tier (spot/perp
// style) and may not represent the flat per-contract commission that
// futures/CDE products actually charge — checking to confirm either way.
export async function getTransactionSummary(
  creds: CoinbaseCredentials
): Promise<unknown> {
  return request(creds, "GET", "/api/v3/brokerage/transaction_summary");
}
