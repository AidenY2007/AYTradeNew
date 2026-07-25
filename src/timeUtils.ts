import type { AssetTradingWindow } from "./types";

export function nowMinsET(): { minsET: number; weekday: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
    weekday: "short",
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  let hour = Number(get("hour"));
  if (hour === 24) hour = 0;
  const minute = Number(get("minute"));
  return { minsET: hour * 60 + minute, weekday: get("weekday") };
}

export function formatMins(mins: number): string {
  const h = Math.floor(mins / 60)
    .toString()
    .padStart(2, "0");
  const m = (mins % 60).toString().padStart(2, "0");
  return `${h}:${m}`;
}

const WEEKEND = new Set(["Sat", "Sun"]);

export function windowStatus(window: AssetTradingWindow): {
  isOpen: boolean;
  label: string;
} {
  const { minsET, weekday } = nowMinsET();
  const isWeekend = window.weekendBlocked && WEEKEND.has(weekday);
  const inEntry =
    !isWeekend &&
    minsET >= window.entryStartMins &&
    minsET <= window.entryCutoffMins;

  if (inEntry) {
    const remaining = window.entryCutoffMins - minsET;
    return { isOpen: true, label: `entry window closes in ${formatMins(remaining)}` };
  }
  if (isWeekend) {
    return { isOpen: false, label: "weekend — blocked" };
  }
  if (minsET < window.entryStartMins) {
    return {
      isOpen: false,
      label: `opens in ${formatMins(window.entryStartMins - minsET)}`,
    };
  }
  return { isOpen: false, label: "closed for today" };
}

export function minsUntilFlatten(window: AssetTradingWindow): string {
  const { minsET } = nowMinsET();
  const remaining = window.flattenMins - minsET;
  if (remaining <= 0) return "past flatten time";
  return formatMins(remaining);
}
