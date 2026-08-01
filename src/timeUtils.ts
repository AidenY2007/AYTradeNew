import type { AssetTradingWindow } from "./types";

export function nowSecondsET(): { secondsET: number; weekday: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    hour12: false,
    weekday: "short",
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  let hour = Number(get("hour"));
  if (hour === 24) hour = 0;
  const minute = Number(get("minute"));
  const second = Number(get("second"));
  return { secondsET: hour * 3600 + minute * 60 + second, weekday: get("weekday") };
}

export function formatSecs(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600)
    .toString()
    .padStart(2, "0");
  const m = Math.floor((totalSeconds % 3600) / 60)
    .toString()
    .padStart(2, "0");
  const s = Math.floor(totalSeconds % 60)
    .toString()
    .padStart(2, "0");
  return `${h}:${m}:${s}`;
}

const WEEKEND = new Set(["Sat", "Sun"]);

export function windowStatus(window: AssetTradingWindow): {
  isOpen: boolean;
  label: string;
} {
  const { secondsET, weekday } = nowSecondsET();
  const entryStartSecs = window.entryStartMins * 60;
  const entryCutoffSecs = window.entryCutoffMins * 60;
  const isWeekend = window.weekendBlocked && WEEKEND.has(weekday);
  const inEntry =
    !isWeekend && secondsET >= entryStartSecs && secondsET <= entryCutoffSecs;

  if (inEntry) {
    const remaining = entryCutoffSecs - secondsET;
    return { isOpen: true, label: `active — entry window closes in ${formatSecs(remaining)}` };
  }
  if (isWeekend) {
    return { isOpen: false, label: "weekend — blocked" };
  }
  if (secondsET < entryStartSecs) {
    return {
      isOpen: false,
      label: `opens in ${formatSecs(entryStartSecs - secondsET)}`,
    };
  }
  return { isOpen: false, label: "blocked — overnight" };
}

// yyyy-mm-dd in ET — used to bucket "today" consistently regardless of the
// viewer's own browser timezone.
export function dateStringET(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
  }).format(date);
}

export function minsUntilFlatten(window: AssetTradingWindow): string {
  const { secondsET } = nowSecondsET();
  const remaining = window.flattenMins * 60 - secondsET;
  if (remaining <= 0) return "past flatten time";
  return formatSecs(remaining);
}

// Same HH:MM:SS format but with a leading day count — needed for countdowns
// that can be multiple days out (unlike the same-day windows above).
export function formatDaysHMS(totalSeconds: number): string {
  const days = Math.floor(totalSeconds / 86400);
  const rest = totalSeconds % 86400;
  return days > 0 ? `${days}d ${formatSecs(rest)}` : formatSecs(rest);
}

const WEEKDAY_ORDER = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const FRIDAY_INDEX = 5;
const MAINTENANCE_START_SECS = (16 * 60 + 45) * 60; // 4:45pm ET — Coinbase's official CFM maintenance window, mirrors isFridayMaintenanceWindow server-side
const MAINTENANCE_END_MINS = 18 * 60 + 15; // 6:15pm ET, minute-granularity — mirrors server exactly

// Mirrors tradingWindow.ts's isFridayMaintenanceWindow() server-side, at the
// same minute granularity, so the dashboard never shows a status the server
// would actually disagree with.
export function isInFridayMaintenanceWindow(): boolean {
  const { secondsET, weekday } = nowSecondsET();
  if (weekday !== "Fri") return false;
  const minsET = Math.floor(secondsET / 60);
  return minsET >= MAINTENANCE_START_SECS / 60 && minsET <= MAINTENANCE_END_MINS;
}

// btc4h never flattens on a timer, so "Flattens in ..." doesn't apply to it —
// this counts down to the next moment entries close for the Friday
// maintenance blackout instead, the only recurring time-based event it has.
export function secondsUntilNextFridayMaintenanceStart(): number {
  const { secondsET, weekday } = nowSecondsET();
  const todayIndex = WEEKDAY_ORDER.indexOf(weekday);
  let daysUntilFriday = (FRIDAY_INDEX - todayIndex + 7) % 7;
  if (daysUntilFriday === 0 && secondsET >= MAINTENANCE_START_SECS) {
    daysUntilFriday = 7; // today's window already started/passed — target next week's
  }
  return daysUntilFriday * 86400 + (MAINTENANCE_START_SECS - secondsET);
}
