import type { FlowState } from "../state.js";
import type { MarketSnapshot, RawSample } from "../types.js";

const INFO_URL = "https://api.hyperliquid.xyz/info";
const VENUE = "hyperliquid";

interface RawAssetCtx {
  funding: string;
  openInterest: string;
  prevDayPx: string;
  dayNtlVlm: string;
  premium: string | null;
  oraclePx: string;
  markPx: string;
  midPx: string | null;
  impactPxs: [string, string] | null;
}

interface RawUniverseItem {
  name: string;
  szDecimals: number;
  maxLeverage: number;
}

async function fetchSnapshots(): Promise<MarketSnapshot[]> {
  const res = await fetch(INFO_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "metaAndAssetCtxs" }),
  });
  if (!res.ok) {
    throw new Error(`hyperliquid info ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as [{ universe: RawUniverseItem[] }, RawAssetCtx[]];
  const universe = data[0].universe;
  const ctxs = data[1];
  const ts = Date.now();
  return universe.map((u, i) => {
    const c = ctxs[i];
    const mark = parseFloat(c.markPx);
    return {
      venue: VENUE,
      symbol: u.name,
      markPx: mark,
      funding: parseFloat(c.funding),
      openInterestUsd: parseFloat(c.openInterest) * mark,
      dayVolumeUsd: parseFloat(c.dayNtlVlm),
      ts,
    };
  });
}

export interface HlPoll {
  ts: number;
  samples: Array<{ symbol: string; sample: RawSample }>;
}

export async function pollHyperliquid(state: FlowState): Promise<HlPoll> {
  const snaps = await fetchSnapshots();
  const ts = Date.now();
  const samples = snaps.map((s) => {
    const sample: RawSample = {
      ts,
      price: s.markPx,
      oi: s.openInterestUsd,
      funding: s.funding,
      dayVol: s.dayVolumeUsd,
    };
    state.push("hyperliquid", s.symbol, sample);
    return { symbol: s.symbol, sample };
  });
  return { ts, samples };
}
