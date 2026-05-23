// mop-style flow ticker. Compact top bar with mini-gauge + regime summary,
// dense tabular grid of markets, vim-like keybindings.
//
// Run:  npm run flow:dash
// Keys: q quit · r refresh · s cycle sort · / filter · f cycle filter
//       v veto-only · ↑↓ select · enter detail

import { readFile, stat } from "node:fs/promises";
import type { FlowRow, FlowSnapshot } from "./types.js";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const CLEAR = "\x1b[2J\x1b[H";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";

const SNAPSHOT_PATH = "data/flow-signals.json";
const REFRESH_MS = Number(process.env.TICKER_REFRESH_MS ?? 3000);
const ROWS = Number(process.env.TICKER_ROWS ?? 25);

function fg(code: number): string {
  return `\x1b[38;5;${code}m`;
}

function colorForScore(score: number | null): number {
  if (score === null) return 244;
  if (score >= 60) return 46;
  if (score >= 20) return 154;
  if (score >= 5) return 190;
  if (score <= -60) return 196;
  if (score <= -20) return 202;
  if (score <= -5) return 208;
  return 244;
}

function fmtScore(score: number | null, width = 5): string {
  if (score === null) return DIM + "·".padStart(width) + RESET;
  const c = colorForScore(score);
  const txt = (score > 0 ? "+" : "") + score;
  return fg(c) + BOLD + txt.padStart(width) + RESET;
}

function fmtPct(x: number, width = 6): string {
  const v = (x * 100).toFixed(2);
  const txt = (x >= 0 ? "+" : "") + v + "%";
  const c = x > 0.002 ? 154 : x < -0.002 ? 202 : 244;
  return fg(c) + txt.padStart(width) + RESET;
}

function fmtFunding(x: number, width = 8): string {
  const v = (x * 100).toFixed(4);
  const txt = (x >= 0 ? "+" : "") + v + "%";
  const c = x > 0.00005 ? 154 : x < -0.00005 ? 202 : 244;
  return fg(c) + txt.padStart(width) + RESET;
}

function fmtUsd(x: number | null, width = 8): string {
  if (x === null || !isFinite(x)) return DIM + "—".padStart(width) + RESET;
  let s: string;
  if (x >= 1e9) s = (x / 1e9).toFixed(1) + "B";
  else if (x >= 1e6) s = (x / 1e6).toFixed(1) + "M";
  else if (x >= 1e3) s = (x / 1e3).toFixed(1) + "K";
  else s = x.toFixed(0);
  return s.padStart(width);
}

function verdictLabel(score: number | null): string {
  if (score === null) return DIM + "WAIT".padEnd(14) + RESET;
  const c = fg(colorForScore(score));
  let label = "NEUTRAL";
  if (score >= 60) label = "STRONG INFLOW";
  else if (score >= 20) label = "INFLOW";
  else if (score <= -60) label = "STRONG OUTFLOW";
  else if (score <= -20) label = "OUTFLOW";
  return c + BOLD + label.padEnd(14) + RESET;
}

// Compact gauge bar for header — width=30 inline.
function renderInlineGauge(score: number, width: number): string {
  const clamped = Math.max(-100, Math.min(100, score));
  const pos = Math.round(((clamped + 100) / 200) * (width - 1));
  let out = "";
  for (let i = 0; i < width; i++) {
    const fraction = i / (width - 1);
    let color = 244;
    if (fraction < 0.2) color = 196;
    else if (fraction < 0.4) color = 202;
    else if (fraction < 0.5) color = 208;
    else if (fraction < 0.55) color = 226;
    else if (fraction < 0.7) color = 190;
    else if (fraction < 0.85) color = 154;
    else color = 46;
    if (i === pos) out += BOLD + fg(color) + "▼" + RESET;
    else out += fg(color) + "▬" + RESET;
  }
  return out;
}

type SortKey = "flow5m" | "flow1h" | "flow24h" | "oi" | "symbol";
type FilterMode = "all" | "inflow" | "outflow" | "strong" | "veto";

const VENUE_CODE: Record<string, string> = {
  hyperliquid: "HL",
  drift: "DRI",
  aevo: "AEV",
  dydx: "DDX",
  pumpfun: "PMP",
};

interface State {
  sort: SortKey;
  filter: FilterMode;
  search: string;
  cursor: number;
  searchMode: boolean;
  lastSnap: FlowSnapshot | null;
  lastAge: number | null;
  lastError: string | null;
}

const state: State = {
  sort: "flow5m",
  filter: "all",
  search: "",
  cursor: 0,
  searchMode: false,
  lastSnap: null,
  lastAge: null,
  lastError: null,
};

async function loadSnapshot(): Promise<void> {
  try {
    const st = await stat(SNAPSHOT_PATH);
    const raw = await readFile(SNAPSHOT_PATH, "utf8");
    state.lastSnap = JSON.parse(raw) as FlowSnapshot;
    state.lastAge = Math.round((Date.now() - st.mtimeMs) / 1000);
    state.lastError = null;
  } catch (e) {
    state.lastSnap = null;
    state.lastError = (e as Error).message;
  }
}

function computeRegime(snap: FlowSnapshot): {
  net: number;
  inflow: number;
  outflow: number;
  total: number;
} {
  const scored = snap.markets.filter((m) => m.flow5m !== null) as Array<
    FlowRow & { flow5m: number }
  >;
  const sum = scored.reduce((s, m) => s + m.flow5m, 0);
  const net =
    scored.length > 0
      ? Math.max(-100, Math.min(100, Math.round((sum / scored.length) * 2)))
      : 0;
  const inflow = scored.filter((m) => m.flow5m > 20).length;
  const outflow = scored.filter((m) => m.flow5m < -20).length;
  return { net, inflow, outflow, total: scored.length };
}

function regimeLabel(net: number): { text: string; color: number } {
  if (net >= 40) return { text: "RISK-ON", color: 46 };
  if (net >= 15) return { text: "TILT UP", color: 154 };
  if (net <= -40) return { text: "RISK-OFF", color: 196 };
  if (net <= -15) return { text: "TILT DOWN", color: 202 };
  return { text: "MIXED", color: 226 };
}

function filterAndSort(rows: FlowRow[]): FlowRow[] {
  let r = rows;
  // Filter mode
  if (state.filter === "inflow") {
    r = r.filter((m) => (m.flow5m ?? 0) > 20);
  } else if (state.filter === "outflow") {
    r = r.filter((m) => (m.flow5m ?? 0) < -20);
  } else if (state.filter === "strong") {
    r = r.filter((m) => Math.abs(m.flow5m ?? 0) >= 60);
  } else if (state.filter === "veto") {
    r = r.filter((m) => (m.flow5m ?? 0) < 20);
  }
  // Search string
  if (state.search) {
    const q = state.search.toLowerCase();
    r = r.filter((m) => m.symbol.toLowerCase().includes(q));
  }
  // Sort
  const key = state.sort;
  if (key === "symbol") {
    r = [...r].sort((a, b) => a.symbol.localeCompare(b.symbol));
  } else if (key === "oi") {
    r = [...r].sort((a, b) => (b.oiUsd ?? 0) - (a.oiUsd ?? 0));
  } else {
    r = [...r].sort((a, b) => {
      const av = a[key] ?? 0;
      const bv = b[key] ?? 0;
      return Math.abs(bv) - Math.abs(av);
    });
  }
  return r;
}

function statusDot(ageSec: number | null): string {
  if (ageSec === null) return fg(196) + "●" + RESET;
  if (ageSec > 90) return fg(196) + "●" + RESET + " stale";
  if (ageSec > 45) return fg(208) + "●" + RESET;
  return fg(46) + "●" + RESET;
}

function renderFrame(): string {
  const lines: string[] = [];
  lines.push(CLEAR + HIDE_CURSOR);
  const now = new Date().toLocaleTimeString();

  if (!state.lastSnap) {
    lines.push(BOLD + "AGENTDESK FLOW" + RESET);
    lines.push("");
    lines.push(
      fg(196) +
        (state.lastError ?? "snapshot missing") +
        RESET,
    );
    lines.push("");
    lines.push(
      DIM +
        "run `npm run flow:headless` in another window, then this view will populate" +
        RESET,
    );
    return lines.join("\n");
  }

  const reg = computeRegime(state.lastSnap);
  const label = regimeLabel(reg.net);
  const gauge = renderInlineGauge(reg.net, 32);
  const netStr =
    fg(label.color) +
    BOLD +
    (reg.net > 0 ? "+" : "") +
    reg.net +
    RESET;

  // Header line 1: title · gauge · net · regime · clock
  lines.push(
    BOLD +
      "AGENTDESK FLOW" +
      RESET +
      "  " +
      gauge +
      "  " +
      netStr +
      "  " +
      fg(label.color) +
      BOLD +
      label.text +
      RESET +
      "  " +
      DIM +
      now +
      "  " +
      RESET +
      statusDot(state.lastAge),
  );

  // Header line 2: counts + snapshot age
  lines.push(
    DIM +
      `Inflow ` +
      RESET +
      fg(46) +
      reg.inflow +
      RESET +
      DIM +
      `  Outflow ` +
      RESET +
      fg(196) +
      reg.outflow +
      RESET +
      DIM +
      `  ${reg.total} markets  snapshot ${state.lastAge ?? "?"}s old  filter=${state.filter}  sort=${state.sort}` +
      (state.search ? `  search="${state.search}"` : "") +
      RESET,
  );
  lines.push("");

  // Column header
  lines.push(
    BOLD +
      " " +
      "Market".padEnd(13) +
      "Flow".padStart(6) +
      "  " +
      "1H".padStart(5) +
      "  " +
      "24H".padStart(5) +
      "    " +
      "OI".padStart(8) +
      "   " +
      "Funding".padStart(8) +
      "   " +
      "OIΔ".padStart(7) +
      "  " +
      "PxΔ".padStart(7) +
      "   " +
      "Verdict" +
      RESET,
  );
  lines.push(DIM + " " + "─".repeat(92) + RESET);

  const filtered = filterAndSort(state.lastSnap.markets);
  if (state.cursor >= filtered.length) state.cursor = Math.max(0, filtered.length - 1);
  const top = filtered.slice(0, ROWS);

  for (let i = 0; i < top.length; i++) {
    const r = top[i];
    const code = VENUE_CODE[r.venue] ?? r.venue.substring(0, 3).toUpperCase();
    const sym = r.symbol.length > 9 ? r.symbol.substring(0, 9) : r.symbol;
    const marker = i === state.cursor ? fg(226) + "▶" + RESET : " ";
    const line =
      marker +
      DIM +
      code.padEnd(4) +
      RESET +
      BOLD +
      sym.padEnd(9) +
      RESET +
      fmtScore(r.flow5m, 6) +
      "  " +
      fmtScore(r.flow1h, 5) +
      "  " +
      fmtScore(r.flow24h, 5) +
      "  " +
      fmtUsd(r.oiUsd, 10) +
      "   " +
      fmtFunding(r.components.funding, 8) +
      "   " +
      fmtPct(r.components.oiDeltaPct, 7) +
      "  " +
      fmtPct(r.components.priceDeltaPct, 7) +
      "   " +
      verdictLabel(r.flow5m);
    lines.push(line);
  }

  if (filtered.length > ROWS) {
    lines.push(
      DIM +
        ` ${filtered.length - ROWS} more rows hidden — press s to sort, / to filter, f to cycle` +
        RESET,
    );
  }

  lines.push("");
  lines.push(DIM + " " + "─".repeat(92) + RESET);

  if (state.searchMode) {
    lines.push(
      " " +
        BOLD +
        "/" +
        RESET +
        state.search +
        BOLD +
        "█" +
        RESET +
        DIM +
        "    [enter] apply  [esc] cancel" +
        RESET,
    );
  } else {
    lines.push(
      " " +
        DIM +
        "[" +
        RESET +
        "q" +
        DIM +
        "]quit  [" +
        RESET +
        "r" +
        DIM +
        "]refresh  [" +
        RESET +
        "s" +
        DIM +
        "]sort  [" +
        RESET +
        "/" +
        DIM +
        "]filter  [" +
        RESET +
        "f" +
        DIM +
        "]cycle: " +
        RESET +
        state.filter +
        DIM +
        "  [" +
        RESET +
        "v" +
        DIM +
        "]veto-only  [" +
        RESET +
        "↑↓" +
        DIM +
        "]select" +
        RESET,
    );
  }

  return lines.join("\n");
}

function cycleSort(): void {
  const order: SortKey[] = ["flow5m", "flow1h", "flow24h", "oi", "symbol"];
  state.sort = order[(order.indexOf(state.sort) + 1) % order.length];
}

function cycleFilter(): void {
  const order: FilterMode[] = ["all", "inflow", "outflow", "strong", "veto"];
  state.filter = order[(order.indexOf(state.filter) + 1) % order.length];
}

async function draw(): Promise<void> {
  await loadSnapshot();
  process.stdout.write(renderFrame());
}

function setupKeybindings(): void {
  if (!process.stdin.isTTY) return;
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");

  process.stdin.on("data", async (chunkRaw) => {
    const chunk = chunkRaw.toString();

    if (state.searchMode) {
      if (chunk === "\r" || chunk === "\n") {
        state.searchMode = false;
      } else if (chunk === "\x1b") {
        state.searchMode = false;
        state.search = "";
      } else if (chunk === "\x7f" || chunk === "\b") {
        state.search = state.search.slice(0, -1);
      } else if (chunk >= " " && chunk <= "~") {
        state.search += chunk;
      }
      await draw();
      return;
    }

    if (chunk === "q" || chunk === "\x03") {
      shutdown();
      return;
    }
    if (chunk === "r") {
      await draw();
      return;
    }
    if (chunk === "s") {
      cycleSort();
      await draw();
      return;
    }
    if (chunk === "f") {
      cycleFilter();
      await draw();
      return;
    }
    if (chunk === "v") {
      state.filter = state.filter === "veto" ? "all" : "veto";
      await draw();
      return;
    }
    if (chunk === "/") {
      state.searchMode = true;
      state.search = "";
      await draw();
      return;
    }
    // Arrow keys: ESC [ A/B/C/D
    if (chunk === "\x1b[A") {
      state.cursor = Math.max(0, state.cursor - 1);
      await draw();
      return;
    }
    if (chunk === "\x1b[B") {
      state.cursor = Math.min(ROWS - 1, state.cursor + 1);
      await draw();
      return;
    }
  });
}

function shutdown(): void {
  process.stdout.write(SHOW_CURSOR + "\n");
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.exit(0);
}

async function main(): Promise<void> {
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  setupKeybindings();
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
