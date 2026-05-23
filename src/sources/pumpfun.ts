import type { FlowState } from "../state.js";
import type { RawSample } from "../types.js";

// Pump.fun has no perp-style OI/funding signal. We synthesize a venue-level
// flow from DexScreener: aggregate Solana pump.fun pairs' 24h volume,
// liquidity-weighted average 1h price change, and active pair count.
const DS_SEARCH = "https://api.dexscreener.com/latest/dex/search?q=pumpfun";

interface DsPair {
  dexId?: string;
  chainId?: string;
  priceUsd?: string;
  liquidity?: { usd?: number };
  volume?: { h24?: number };
  priceChange?: { h1?: number; h24?: number };
}

interface DsResponse {
  pairs?: DsPair[];
}

export const PUMPFUN_VENUE = "pumpfun";
export const PUMPFUN_SYMBOL = "PUMP.FUN";

export async function pollPumpfun(
  state: FlowState,
): Promise<{ ts: number; sample: RawSample } | null> {
  let body: DsResponse;
  try {
    const r = await fetch(DS_SEARCH);
    if (!r.ok) return null;
    body = (await r.json()) as DsResponse;
  } catch {
    return null;
  }

  const pairs = (body.pairs ?? []).filter((p) => p.chainId === "solana");
  if (!pairs.length) return null;

  const totalVol = pairs.reduce((s, p) => s + (p.volume?.h24 ?? 0), 0);
  const totalLiq = pairs.reduce((s, p) => s + (p.liquidity?.usd ?? 0), 0);
  const wAvgH1 =
    totalLiq > 0
      ? pairs.reduce(
          (s, p) => s + (p.priceChange?.h1 ?? 0) * (p.liquidity?.usd ?? 0),
          0,
        ) / totalLiq
      : 0;

  const ts = Date.now();
  const sample: RawSample = {
    ts,
    price: 100 * (1 + wAvgH1 / 100),
    oi: pairs.length,
    funding: 0,
    dayVol: totalVol,
  };
  state.push(PUMPFUN_VENUE, PUMPFUN_SYMBOL, sample);
  return { ts, sample };
}
