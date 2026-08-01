import { Asset } from "./admin";
import { AssetTradingWindow } from "./types";

const ET_ZONE = "America/New_York";

function nowInET(date: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: ET_ZONE,
    hour: "numeric",
    minute: "numeric",
    hour12: false,
    weekday: "short",
  }).formatToParts(date);

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  let hour = Number(get("hour"));
  if (hour === 24) hour = 0;
  const minute = Number(get("minute"));
  const weekday = get("weekday");
  return { minsET: hour * 60 + minute, weekday };
}

const WEEKEND_DAYS = new Set(["Sat", "Sun"]);

export interface WindowCheck {
  ok: boolean;
  reason?: string;
}

// Mirrors the Pine scripts' timeOK logic: inEntryWindow and not inWeekendBlock.
export function isWithinEntryWindow(
  window: AssetTradingWindow,
  now: Date = new Date()
): WindowCheck {
  const { minsET, weekday } = nowInET(now);

  if (window.weekendBlocked && WEEKEND_DAYS.has(weekday)) {
    return { ok: false, reason: "weekend" };
  }
  if (minsET < window.entryStartMins || minsET > window.entryCutoffMins) {
    return { ok: false, reason: "outside_entry_window" };
  }
  return { ok: true };
}

// Mirrors the Pine scripts' pastFlatten / daily flatten cutoff.
export function isPastFlattenTime(
  window: AssetTradingWindow,
  now: Date = new Date()
): boolean {
  const { minsET } = nowInET(now);
  return minsET >= window.flattenMins;
}

// Mirrors the Pine scripts' inCooldown check (clock-based, ms since last exit).
export function isInCooldown(
  window: AssetTradingWindow,
  lastExitTime: Date | null,
  now: Date = new Date()
): boolean {
  if (!lastExitTime) return false;
  const elapsedMs = now.getTime() - lastExitTime.getTime();
  return elapsedMs < window.cooldownHours * 3600_000;
}

// Coinbase's official CFM futures maintenance window: every Friday,
// 4:45pm-6:15pm ET. Hardcoded rather than checked via product.isSessionOpen
// (Coinbase's live session-status API field) — that field is meant for the
// equity-index perps' real market hours, not specifically this maintenance
// window, so it's not a reliable signal to gate btc4h's entries on. Only
// btc4h checks this — the other assets flatten daily well before a
// Friday-evening window would ever matter.
export function isFridayMaintenanceWindow(now: Date = new Date()): boolean {
  const { minsET, weekday } = nowInET(now);
  if (weekday !== "Fri") return false;
  return minsET >= 16 * 60 + 45 && minsET <= 18 * 60 + 15;
}

export function checkEntryAllowed(
  window: AssetTradingWindow,
  lastExitTime: Date | null,
  now: Date = new Date()
): WindowCheck {
  const windowCheck = isWithinEntryWindow(window, now);
  if (!windowCheck.ok) return windowCheck;

  if (isInCooldown(window, lastExitTime, now)) {
    return { ok: false, reason: "cooldown" };
  }

  // Never allow an entry that would still be open past today's flatten time —
  // matches the user's absolute rule of never holding a position overnight.
  if (isPastFlattenTime(window, now)) {
    return { ok: false, reason: "past_flatten_time" };
  }

  return { ok: true };
}

export type { Asset };
