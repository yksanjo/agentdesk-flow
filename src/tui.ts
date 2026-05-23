import type { FlowRow } from "./types.js";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const CLEAR = "\x1b[2J\x1b[H";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";

function color(score: number | null): string {
  if (score === null) return DIM;
  if (score >= 60) return "\x1b[38;5;46m"; // bright green
  if (score >= 20) return "\x1b[38;5;82m"; // green
  if (score >= 5) return "\x1b[38;5;120m"; // pale green
  if (score <= -60) return "\x1b[38;5;196m"; // bright red
  if (score <= -20) return "\x1b[38;5;160m"; // red
  if (score <= -5) return "\x1b[38;5;167m"; // pale red
  return DIM;
}

function arrow(score: number | null): string {
  if (score === null) return "·";
  if (score >= 20) return "▲";
  if (score <= -20) return "▼";
  return "─";
}

function fmtScore(score: number | null): string {
  if (score === null) return "  ·";
  const sign = score > 0 ? "+" : score < 0 ? "" : " ";
  return `${sign}${score}`.padStart(4);
}

function fmtPct(x: number, digits = 2): string {
  const v = (x * 100).toFixed(digits);
  return (x >= 0 ? "+" : "") + v + "%";
}

function fmtUsd(x: number | null): string {
  if (x === null || !isFinite(x)) return "—";
  if (x >= 1e9) return (x / 1e9).toFixed(1) + "B";
  if (x >= 1e6) return (x / 1e6).toFixed(1) + "M";
  if (x >= 1e3) return (x / 1e3).toFixed(1) + "K";
  return x.toFixed(0);
}

function takerBar(score: number | null): string {
  if (score === null) return "·····";
  const mag = Math.min(5, Math.round(Math.abs(score) / 20));
  return "●".repeat(mag) + "○".repeat(5 - mag);
}

function header(asOf: string, count: number): string {
  return (
    BOLD +
    "FLOW LEADERBOARD" +
    RESET +
    DIM +
    `   (5m / 1h / 24h)   ${asOf}   ${count} markets   ctrl-c to exit` +
    RESET +
    "\n" +
    DIM +
    "─".repeat(78) +
    RESET +
    "\n" +
    BOLD +
    " VENUE       SYMBOL   FLOW   1H    24H    OI         FUND     OI Δ    PX Δ  STRENGTH" +
    RESET +
    "\n"
  );
}

function renderRow(r: FlowRow): string {
  const c = color(r.flow5m);
  const f5 = fmtScore(r.flow5m);
  const f1h = fmtScore(r.flow1h);
  const f24 = fmtScore(r.flow24h);
  const arr = arrow(r.flow5m);
  const venue = r.venue.padEnd(11);
  const sym = r.symbol.padEnd(8);
  const oi = fmtUsd(r.oiUsd).padStart(9);
  const fund = (r.components.funding * 100).toFixed(4).padStart(7) + "%";
  const oiD = fmtPct(r.components.oiDeltaPct, 1).padStart(7);
  const pxD = fmtPct(r.components.priceDeltaPct, 2).padStart(7);
  const bar = takerBar(r.flow5m);
  return (
    ` ${DIM}${venue}${RESET}${sym} ${c}${arr} ${f5}${RESET}  ${color(r.flow1h)}${f1h}${RESET}  ${color(r.flow24h)}${f24}${RESET}  ${oi}  ${fund}  ${oiD}  ${pxD}  ${c}${bar}${RESET}\n`
  );
}

export function render(rows: FlowRow[], topN: number, asOf: string): string {
  const sorted = [...rows].sort(
    (a, b) => Math.abs(b.flow5m ?? 0) - Math.abs(a.flow5m ?? 0),
  );
  const top = sorted.slice(0, topN);
  let out = CLEAR + HIDE_CURSOR + header(asOf, rows.length);
  for (const r of top) out += renderRow(r);

  // Aggregate footer: net flow + inflow vs outflow count
  const scored = rows.filter((r) => r.flow5m !== null) as Array<
    FlowRow & { flow5m: number }
  >;
  const net = scored.reduce((s, r) => s + r.flow5m, 0);
  const inflow = scored.filter((r) => r.flow5m > 20).length;
  const outflow = scored.filter((r) => r.flow5m < -20).length;
  const regime =
    net > 200
      ? color(80) + "RISK-ON"
      : net < -200
        ? color(-80) + "RISK-OFF"
        : DIM + "MIXED";
  out +=
    "\n" +
    DIM +
    "─".repeat(78) +
    RESET +
    "\n" +
    ` net5m=${color(net)}${net > 0 ? "+" : ""}${net}${RESET}   ` +
    `inflow=${color(60)}${inflow}${RESET}   ` +
    `outflow=${color(-60)}${outflow}${RESET}   ` +
    `regime=${regime}${RESET}\n`;
  return out;
}

export function showCursor(): void {
  process.stdout.write(SHOW_CURSOR);
}
