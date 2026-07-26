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
    return { isOpen: true, label: `entry window closes in ${formatSecs(remaining)}` };
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
  return { isOpen: false, label: "closed for today" };
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
