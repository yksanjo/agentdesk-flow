// Standalone CLI dashboard. Reads `data/flow-signals.json` produced by the
// flow daemon and renders a Fear-and-Greed-style gauge + per-asset mini gauges
// + bot veto status panel. Pure reader — does not poll any APIs.
//
// Run alongside the producer:
//   terminal A:  npm run flow:headless
//   terminal B:  npm run flow:dash
// or all-in-one:
//   npm run flow:dash -- --with-producer

import { readFile, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import {
  renderBar,
  renderNeedle,
  renderTicks,
  renderZones,
  renderMiniGauge,
  renderScoreBlock,
  renderSparkline,
} from "./gauge.js";
import type { FlowSnapshot, FlowRow } from "./types.js";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const CLEAR = "\x1b[2J\x1b[H";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";

const SNAPSHOT_PATH = "data/flow-signals.json";
const REFRESH_MS = Number(process.env.DASH_REFRESH_MS ?? 5000);
const BAR_WIDTH = 60;

const FOCUS_ENV = process.env.DASH_FOCUS;
const FOCUS_ASSETS = FOCUS_ENV
  ? FOCUS_ENV.split(",").map((s) => s.trim().toUpperCase())
  : ["BTC", "ETH", "SOL", "HYPE", "DOGE", "PUMP.FUN"];

const WITH_PRODUCER = process.argv.includes("--with-producer");

interface Snap {
  snap: FlowSnapshot | null;
  ageSec: number | null;
  error: string | null;
}

const sparkHistory: number[] = [];
const SPARK_MAX = 32;

async function loadSnapshot(): Promise<Snap> {
  try {
    const st = await stat(SNAPSHOT_PATH);
    const raw = await readFile(SNAPSHOT_PATH, "utf8");
    const snap = JSON.parse(raw) as FlowSnapshot;
    const ageSec = Math.round((Date.now() - st.mtimeMs) / 1000);
    return { snap, ageSec, error: null };
  } catch (e) {
    return { snap: null, ageSec: null, error: (e as Error).message };
  }
}

function computeRegime(snap: FlowSnapshot): {
  net: number;
  inflow: number;
  outflow: number;
  total: number;
  pumpRow: FlowRow | null;
} {
  const scored = snap.markets.filter((m) => m.flow5m !== null) as Array<
    FlowRow & { flow5m: number }
  >;
  const net = scored.reduce((s, m) => s + m.flow5m, 0);
  const inflow = scored.filter((m) => m.flow5m > 20).length;
  const outflow = scored.filter((m) => m.flow5m < -20).length;
  // Normalize net flow to [-100, +100] for the main gauge. Divisor = count of
  // scored markets ≈ avg flow across all markets. ×2 for sensitivity so we
  // hit the colored zones without needing every market in agreement.
  const normalized =
    scored.length > 0
      ? Math.max(-100, Math.min(100, Math.round((net / scored.length) * 2)))
      : 0;
  const pumpRow = snap.markets.find((m) => m.venue === "pumpfun") ?? null;
  return {
    net: normalized,
    inflow,
    outflow,
    total: scored.length,
    pumpRow,
  };
}

function box(title: string, width: number): { top: string; bottom: string } {
  const titleStr = ` ${title} `;
  const left = "╭─";
  const right = "─╮";
  const filler = "─".repeat(
    Math.max(0, width - left.length - right.length - titleStr.length),
  );
  return {
    top: DIM + left + RESET + BOLD + titleStr + RESET + DIM + filler + right + RESET,
    bottom: DIM + "╰" + "─".repeat(width - 2) + "╯" + RESET,
  };
}

function pad(s: string, w: number): string {
  // pad accounting for ANSI escape sequences
  // eslint-disable-next-line no-control-regex
  const visible = s.replace(/\x1b\[[0-9;]*m/g, "").length;
  return s + " ".repeat(Math.max(0, w - visible));
}

function renderMainGauge(score: number): string {
  const left = "  ";
  const out: string[] = [];
  const needleLines = renderNeedle(score, BAR_WIDTH).split("\n");
  out.push(left + needleLines[0]);
  out.push(left + needleLines[1]);
  out.push(left + renderBar(BAR_WIDTH));
  out.push(left + renderTicks(BAR_WIDTH));
  out.push(left + renderZones(BAR_WIDTH));
  return out.join("\n");
}

const VENUE_CODE: Record<string, string> = {
  hyperliquid: "HL",
  drift: "DRI",
  aevo: "AEV",
  dydx: "DDX",
  pumpfun: "PMP",
};

function renderAssetRow(row: FlowRow): string {
  const sym = pad(row.symbol, 9);
  const code = VENUE_CODE[row.venue] ?? row.venue.substring(0, 3).toUpperCase();
  const venue = pad(DIM + code + RESET, 3);
  const gauge = renderMiniGauge(row.flow5m, 25);
  const block = renderScoreBlock(row.flow5m);
  const score = pad(block.number, 5);
  const verdict = pad(block.verdict, 18);
  return ` ${venue} ${BOLD}${sym}${RESET} ${gauge}  ${score}  ${verdict}`;
}

function renderVetoStatus(
  rows: FlowRow[],
  regimeScore: number,
): string {
  const out: string[] = [];
  // Hardcoded veto rules — make them visible so user understands the logic.
  const checks: Array<{
    label: string;
    venue: string;
    symbol: string;
    side: "long" | "short" | "either";
    minScore: number;
  }> = [
    { label: "hl:BTC long", venue: "hyperliquid", symbol: "BTC", side: "long", minScore: 20 },
    { label: "hl:SOL long", venue: "hyperliquid", symbol: "SOL", side: "long", minScore: 20 },
    { label: "hl:HYPE long", venue: "hyperliquid", symbol: "HYPE", side: "long", minScore: 20 },
    { label: "pump.fun long", venue: "pumpfun", symbol: "PUMP.FUN", side: "long", minScore: 20 },
  ];

  // Global circuit breaker: if regime <= -40, veto everything
  const breaker = regimeScore <= -40;

  for (const c of checks) {
    const row = rows.find((r) => r.venue === c.venue && r.symbol === c.symbol);
    const s = row?.flow5m ?? null;
    let allow = false;
    let reason = "";
    if (breaker) {
      reason = `regime ${regimeScore} (circuit breaker)`;
    } else if (s === null) {
      reason = "no signal yet";
    } else if (c.side === "long" && s >= c.minScore) {
      allow = true;
      reason = `flow=+${s}`;
    } else if (c.side === "short" && s <= -c.minScore) {
      allow = true;
      reason = `flow=${s}`;
    } else {
      reason = `flow=${s > 0 ? "+" : ""}${s} < ±${c.minScore}`;
    }
    const tag = allow
      ? "\x1b[38;5;46m" + BOLD + "✓ ALLOW " + RESET
      : "\x1b[38;5;196m" + BOLD + "✗ VETO  " + RESET;
    out.push(`  ${tag} ${pad(c.label, 16)} ${DIM}${reason}${RESET}`);
  }
  return out.join("\n");
}

function renderTopMovers(snap: FlowSnapshot, n: number): string {
  const scored = snap.markets.filter(
    (m) => m.flow5m !== null,
  ) as Array<FlowRow & { flow5m: number }>;
  const sorted = [...scored].sort((a, b) => Math.abs(b.flow5m) - Math.abs(a.flow5m));
  const top = sorted.slice(0, n);
  if (!top.length) return DIM + "  (no scored markets yet — waiting for second poll)" + RESET;
  return top.map((r) => renderAssetRow(r)).join("\n");
}

function renderFrame(snap: Snap): string {
  const W = 78;
  const now = new Date().toLocaleTimeString();
  const lines: string[] = [];
  lines.push(CLEAR + HIDE_CURSOR);

  // Header
  const hdr = box(`AGENTDESK CAPITAL FLOW`, W);
  lines.push(hdr.top);
  const subtitle = snap.snap
    ? `${snap.snap.markets.length} markets · snapshot ${snap.ageSec}s old · ${now}`
    : `NO SNAPSHOT YET — run \`npm run flow:headless\` first`;
  lines.push(`  ${DIM}${subtitle}${RESET}`);
  lines.push("");

  if (!snap.snap) {
    lines.push(`  ${"\x1b[38;5;196m"}${BOLD}${snap.error ?? "snapshot file missing"}${RESET}`);
    lines.push(hdr.bottom);
    return lines.join("\n");
  }

  const reg = computeRegime(snap.snap);
  sparkHistory.push(reg.net);
  if (sparkHistory.length > SPARK_MAX) sparkHistory.shift();

  // Main gauge
  lines.push(BOLD + "  MARKET REGIME" + RESET);
  lines.push(renderMainGauge(reg.net));
  lines.push("");

  const block = renderScoreBlock(reg.net);
  const sparkStr = renderSparkline(sparkHistory);
  lines.push(
    `  ${BOLD}NET FLOW${RESET}  ${block.number}     ` +
      `${BOLD}VERDICT${RESET}  ${block.verdict}     ` +
      `${BOLD}TREND${RESET}  ${sparkStr}`,
  );
  lines.push(
    `  ${DIM}${reg.inflow} markets inflowing · ${reg.outflow} outflowing · ${reg.total} total scored${RESET}`,
  );
  lines.push("");

  // Per-asset mini gauges
  lines.push(BOLD + "  WATCHLIST" + RESET + DIM + "   (DASH_FOCUS=BTC,ETH,... to customize)" + RESET);
  lines.push(DIM + "  " + "─".repeat(W - 4) + RESET);
  for (const sym of FOCUS_ASSETS) {
    const row =
      snap.snap.markets.find(
        (m) => m.symbol.toUpperCase() === sym && m.venue !== "pumpfun",
      ) ??
      snap.snap.markets.find((m) => m.symbol.toUpperCase() === sym);
    if (row) lines.push(renderAssetRow(row));
    else lines.push(`  ${DIM}${sym} — not found${RESET}`);
  }
  lines.push("");

  // Top movers (auto-detected)
  lines.push(BOLD + "  TOP MOVERS" + RESET + DIM + "   (by |flow5m|)" + RESET);
  lines.push(DIM + "  " + "─".repeat(W - 4) + RESET);
  lines.push(renderTopMovers(snap.snap, 5));
  lines.push("");

  // Bot veto status
  lines.push(BOLD + "  BOT VETO STATUS" + RESET);
  lines.push(DIM + "  " + "─".repeat(W - 4) + RESET);
  lines.push(renderVetoStatus(snap.snap.markets, reg.net));
  lines.push("");

  // Footer
  lines.push(
    DIM + `  ↻ refresh ${REFRESH_MS / 1000}s · ctrl-c to exit` + RESET,
  );
  lines.push(hdr.bottom);
  return lines.join("\n");
}

let producer: ReturnType<typeof spawn> | null = null;

async function main(): Promise<void> {
  if (WITH_PRODUCER) {
    producer = spawn("npx", ["tsx", "src/flow/daemon.ts"], {
      env: { ...process.env, FLOW_HEADLESS: "1" },
      stdio: ["ignore", "ignore", "ignore"],
    });
  }

  const cleanup = (): void => {
    process.stdout.write(SHOW_CURSOR);
    if (producer) producer.kill("SIGTERM");
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  const draw = async (): Promise<void> => {
    const snap = await loadSnapshot();
    process.stdout.write(renderFrame(snap));
  };

  await draw();
  setInterval(() => {
    draw().catch((e) => console.error("draw failed:", e));
  }, REFRESH_MS);
}

main().catch((err) => {
  process.stdout.write(SHOW_CURSOR);
  console.error("fatal:", err);
  process.exit(1);
});
