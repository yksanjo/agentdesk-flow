import { readFile } from "node:fs/promises";
import type { FlowRow, FlowSnapshot } from "./types.js";

const SNAPSHOT_PATH = "data/flow-signals.json";

export interface VetoOptions {
  // Reject entry if the chosen window's flow score is below this.
  // Default 20 = at least "INFLOW" verdict.
  minScore?: number;
  // Snapshot must be no older than this many ms. Default 90s.
  maxAgeMs?: number;
  // Which window to consult. Default "5m".
  window?: "5m" | "1h" | "24h";
  // Which direction the bot is taking. "long" requires positive flow,
  // "short" requires negative flow, "either" requires |flow| ≥ minScore.
  side?: "long" | "short" | "either";
  // If snapshot is missing or stale, fail-open (allow) or fail-closed (veto)?
  // Default: fail-closed — a missing signal is a veto.
  failOpen?: boolean;
}

export interface VetoDecision {
  allow: boolean;
  reason: string;
  score: number | null;
  row: FlowRow | null;
}

let cached: { ts: number; snap: FlowSnapshot } | null = null;

async function loadSnapshot(): Promise<FlowSnapshot | null> {
  // Cache for 5 seconds to avoid reread storms when many bots check at once.
  if (cached && Date.now() - cached.ts < 5_000) return cached.snap;
  try {
    const raw = await readFile(SNAPSHOT_PATH, "utf8");
    const snap = JSON.parse(raw) as FlowSnapshot;
    cached = { ts: Date.now(), snap };
    return snap;
  } catch {
    return null;
  }
}

// Bot integration point.
// Example:
//   const v = await flowVeto('hyperliquid', 'SOL', { side: 'long', minScore: 30 });
//   if (!v.allow) { log(`vetoed: ${v.reason}`); return; }
export async function flowVeto(
  venue: string,
  symbol: string,
  opts: VetoOptions = {},
): Promise<VetoDecision> {
  const minScore = opts.minScore ?? 20;
  const maxAgeMs = opts.maxAgeMs ?? 90_000;
  const window = opts.window ?? "5m";
  const side = opts.side ?? "either";
  const failOpen = opts.failOpen ?? false;

  const snap = await loadSnapshot();
  if (!snap) {
    return {
      allow: failOpen,
      reason: failOpen ? "no-snapshot:fail-open" : "no-snapshot:fail-closed",
      score: null,
      row: null,
    };
  }

  const ageMs = Date.now() - new Date(snap.asOf).getTime();
  if (ageMs > maxAgeMs) {
    return {
      allow: failOpen,
      reason: `snapshot-stale ${Math.round(ageMs / 1000)}s`,
      score: null,
      row: null,
    };
  }

  const row =
    snap.markets.find((m) => m.venue === venue && m.symbol === symbol) ?? null;
  if (!row) {
    return {
      allow: failOpen,
      reason: `no-row ${venue}:${symbol}`,
      score: null,
      row: null,
    };
  }

  const score =
    window === "5m" ? row.flow5m : window === "1h" ? row.flow1h : row.flow24h;
  if (score === null) {
    return {
      allow: failOpen,
      reason: `score-null window=${window}`,
      score: null,
      row,
    };
  }

  const directionOk =
    side === "either"
      ? Math.abs(score) >= minScore
      : side === "long"
        ? score >= minScore
        : score <= -minScore;

  if (!directionOk) {
    return {
      allow: false,
      reason: `flow=${score} side=${side} min=${minScore}`,
      score,
      row,
    };
  }

  return {
    allow: true,
    reason: `flow=${score} verdict=${row.verdict}`,
    score,
    row,
  };
}

// Synchronous regime check — returns net5m flow across all markets, useful as
// a global circuit breaker ("if entire market is bleeding, halt all entries").
export async function marketRegime(): Promise<{
  net: number;
  inflow: number;
  outflow: number;
  ageSec: number | null;
}> {
  const snap = await loadSnapshot();
  if (!snap) return { net: 0, inflow: 0, outflow: 0, ageSec: null };
  const scored = snap.markets.filter((m) => m.flow5m !== null);
  const net = scored.reduce((s, m) => s + (m.flow5m ?? 0), 0);
  const inflow = scored.filter((m) => (m.flow5m ?? 0) > 20).length;
  const outflow = scored.filter((m) => (m.flow5m ?? 0) < -20).length;
  const ageSec = Math.round(
    (Date.now() - new Date(snap.asOf).getTime()) / 1000,
  );
  return { net, inflow, outflow, ageSec };
}
