// Rounds a raw contract size down to the product's base increment and
// returns it formatted with the same decimal precision as the increment.
export function formatBaseSize(rawSize: number, baseIncrement: number): string {
  if (rawSize <= 0) return "0";
  const steps = Math.floor(rawSize / baseIncrement);
  const size = steps * baseIncrement;
  const decimals = baseIncrement.toString().includes(".")
    ? baseIncrement.toString().split(".")[1].length
    : 0;
  return size.toFixed(decimals);
}

// Max contracts affordable using the full account balance as margin at the
// product's max leverage. `contractSize` is the notional value of one
// contract in the underlying's own units (e.g. 0.01 BTC for the nano
// contract) — price alone is not the per-contract notional unless
// contractSize is 1.
export function computeMaxContractsSize(
  balance: number,
  price: number,
  maxLeverage: number,
  baseIncrement: number,
  contractSize: number
): string {
  const notional = balance * maxLeverage;
  const notionalPerContract = price * contractSize;
  const rawSize = notional / notionalPerContract;
  return formatBaseSize(rawSize, baseIncrement);
}
