export function pnlColor(value: number): string {
  if (value === 0) return "var(--text)";
  return value > 0 ? "var(--green)" : "var(--red)";
}

export function pnlSign(value: number): string {
  return value > 0 ? "+" : "";
}

// Long/short color coding used sitewide (Overview's position widget, Trade
// Log, Missed Entries).
export function sideColor(side?: string | null): string {
  if (side === "long") return "var(--blue)";
  if (side === "short") return "var(--yellow)";
  return "var(--text-dim)";
}

// The whole system runs on Eastern Time, so timestamps always display in ET
// regardless of the viewer's own browser/OS timezone.
export function formatTimeET(ts?: { seconds: number } | null): string {
  if (!ts) return "—";
  const formatted = new Date(ts.seconds * 1000).toLocaleString("en-US", {
    timeZone: "America/New_York",
    dateStyle: "short",
    timeStyle: "medium",
  });
  return `${formatted} ET`;
}
