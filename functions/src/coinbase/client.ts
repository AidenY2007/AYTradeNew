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
};

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
  return {
    futuresBuyingPower: Number(
      summary.futures_buying_power?.value ?? summary.cfm_usd_balance?.value ?? 0
    ),
    totalUsdBalance: Number(
      summary.total_usd_balance?.value ?? summary.cfm_usd_balance?.value ?? 0
    ),
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
  // Notional value of one contract in the underlying's own units, e.g. 0.01
  // for BTC's nano contract, 1 for the equity-index perps.
  contractSize: number;
  // Fraction of notional required as margin, intraday — leverage = 1/rate.
  // Long/short rates differ slightly, so both are kept and picked by side.
  intradayLongMarginRate: number;
  intradayShortMarginRate: number;
  // Equity-index perps (Tech/AI/China) trade real market hours, not 24/7 —
  // must be checked before every order, separately from our own time rules.
  isSessionOpen: boolean;
  raw: unknown;
}

export async function getProduct(
  creds: CoinbaseCredentials,
  productId: string
): Promise<ProductInfo> {
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
    contractSize: Number(futureDetails.contract_size ?? 1),
    intradayLongMarginRate: Number(
      futureDetails.intraday_margin_rate?.long_margin_rate ?? 1
    ),
    intradayShortMarginRate: Number(
      futureDetails.intraday_margin_rate?.short_margin_rate ?? 1
    ),
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
  return {
    avgFilledPrice: order.average_filled_price
      ? Number(order.average_filled_price)
      : null,
    filledSize: order.filled_size ? Number(order.filled_size) : null,
    status: order.status,
    raw: json,
  };
}

export async function cancelOrder(
  creds: CoinbaseCredentials,
  orderId: string
): Promise<void> {
  await request(creds, "POST", "/api/v3/brokerage/orders/batch_cancel", {
    order_ids: [orderId],
  });
}

export async function getOpenPositions(
  creds: CoinbaseCredentials
): Promise<unknown> {
  return request(creds, "GET", "/api/v3/brokerage/cfm/positions");
}
