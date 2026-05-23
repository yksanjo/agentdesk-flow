import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { FlowState } from "./state.js";
import { pollHyperliquid } from "./sources/hyperliquid.js";
import {
  pollPumpfun,
  PUMPFUN_SYMBOL,
  PUMPFUN_VENUE,
} from "./sources/pumpfun.js";
import { scoreWindow, verdict } from "./score.js";
import { render, showCursor } from "./tui.js";
import type { FlowRow, FlowSnapshot, RawSample } from "./types.js";

const SNAPSHOT_PATH = "data/flow-signals.json";
const POLL_MS = Number(process.env.FLOW_POLL_MS ?? 30_000);
const TOP_N = Number(process.env.FLOW_TOP_N ?? 30);
const HEADLESS = process.env.FLOW_HEADLESS === "1";
const ONESHOT = process.argv.includes("--once");

// FLOW_FAST=1 collapses windows to 30s/2m/10m for demos and TUI dev.
// Default windows stay at 5m / 1h / 24h for real signals.
const FAST = process.env.FLOW_FAST === "1";
const FIVE_MIN = FAST ? 30 * 1000 : 5 * 60 * 1000;
const ONE_HOUR = FAST ? 2 * 60 * 1000 : 60 * 60 * 1000;
const ONE_DAY = FAST ? 10 * 60 * 1000 : 24 * 60 * 60 * 1000;

function buildRow(
  state: FlowState,
  venue: string,
  symbol: string,
  curr: RawSample,
): FlowRow {
  const now = curr.ts;
  const fiveAgo = state.near(venue, symbol, now - FIVE_MIN);
  const hourAgo = state.near(venue, symbol, now - ONE_HOUR);
  const dayAgo = state.near(venue, symbol, now - ONE_DAY);

  const w5 = scoreWindow(fiveAgo, curr);
  const w1h = scoreWindow(hourAgo, curr);
  const w24 = scoreWindow(dayAgo, curr);

  return {
    venue,
    symbol,
    markPx: curr.price,
    oiUsd: venue === PUMPFUN_VENUE ? null : curr.oi,
    dayVolUsd: curr.dayVol,
    flow5m: w5.score,
    flow1h: w1h.score,
    flow24h: w24.score,
    components: w5.components,
    verdict: verdict(w5.score),
    updatedAt: now,
  };
}

async function writeSnapshot(rows: FlowRow[]): Promise<void> {
  const snap: FlowSnapshot = {
    asOf: new Date().toISOString(),
    windows: ["5m", "1h", "24h"],
    markets: rows,
  };
  await mkdir(dirname(SNAPSHOT_PATH), { recursive: true });
  await writeFile(SNAPSHOT_PATH, JSON.stringify(snap, null, 2));
}

async function tick(state: FlowState): Promise<FlowRow[]> {
  const rows: FlowRow[] = [];

  // Run both sources in parallel; tolerate individual failures.
  const [hlResult, pfResult] = await Promise.allSettled([
    pollHyperliquid(state),
    pollPumpfun(state),
  ]);

  if (hlResult.status === "fulfilled") {
    for (const { symbol, sample } of hlResult.value.samples) {
      rows.push(buildRow(state, "hyperliquid", symbol, sample));
    }
  } else {
    console.error("hyperliquid poll failed:", hlResult.reason);
  }

  if (pfResult.status === "fulfilled" && pfResult.value) {
    rows.push(
      buildRow(state, PUMPFUN_VENUE, PUMPFUN_SYMBOL, pfResult.value.sample),
    );
  } else if (pfResult.status === "rejected") {
    console.error("pumpfun poll failed:", pfResult.reason);
  }

  return rows;
}

async function main(): Promise<void> {
  const state = new FlowState();
  await state.restore();

  let stopping = false;
  const cleanup = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    showCursor();
    try {
      await state.persist();
    } catch (e) {
      console.error("persist failed:", e);
    }
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  const runOnce = async (): Promise<void> => {
    const rows = await tick(state);
    await writeSnapshot(rows);
    if (!HEADLESS) {
      process.stdout.write(render(rows, TOP_N, new Date().toLocaleTimeString()));
    } else {
      const net = rows
        .filter((r) => r.flow5m !== null)
        .reduce((s, r) => s + (r.flow5m ?? 0), 0);
      console.log(
        `[${new Date().toISOString()}] markets=${rows.length} net5m=${net}`,
      );
    }
  };

  await runOnce();
  if (ONESHOT) {
    await state.persist();
    showCursor();
    return;
  }

  setInterval(() => {
    runOnce().catch((e) => console.error("tick failed:", e));
  }, POLL_MS);

  // Persist state every 5 minutes so a restart keeps rolling-window context.
  setInterval(() => {
    state.persist().catch((e) => console.error("persist failed:", e));
  }, 5 * 60 * 1000);
}

main().catch((err) => {
  showCursor();
  console.error("fatal:", err);
  process.exit(1);
});
