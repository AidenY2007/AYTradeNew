import { PositionDoc } from "./types";

// Mirrors 4hrbtc.pine's stale-position rule: after this long held, the take
// profit tightens from the position's original tpDollars to this smaller
// amount, so a long-running trade can close on a smaller move. Tracked here
// off the position's real entryTime rather than Pine's own bar count, so it
// survives independent of Pine and works identically for live and dry-run.
export const STALE_AFTER_DAYS = 20;
export const STALE_TP_DOLLARS = 1000;

export function effectiveTpDollars(
  position: Pick<PositionDoc, "asset" | "tpDollars" | "entryTime">,
  now: Date = new Date()
): number | null {
  if (position.asset !== "btc4h") return position.tpDollars;
  const ageMs = now.getTime() - position.entryTime.toMillis();
  const staleAfterMs = STALE_AFTER_DAYS * 24 * 60 * 60 * 1000;
  return ageMs >= staleAfterMs ? STALE_TP_DOLLARS : position.tpDollars;
}
