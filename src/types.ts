export type FlowVerdict =
  | "STRONG_INFLOW"
  | "INFLOW"
  | "NEUTRAL"
  | "OUTFLOW"
  | "STRONG_OUTFLOW";

export interface FlowComponents {
  oiDeltaPct: number;
  priceDeltaPct: number;
  funding: number;
  volumeDeltaPct: number;
}

export interface FlowRow {
  venue: string;
  symbol: string;
  markPx: number | null;
  oiUsd: number | null;
  dayVolUsd: number | null;
  flow5m: number | null;
  flow1h: number | null;
  flow24h: number | null;
  components: FlowComponents;
  verdict: FlowVerdict;
  updatedAt: number;
}

export interface FlowSnapshot {
  asOf: string;
  windows: string[];
  markets: FlowRow[];
}

export interface RawSample {
  ts: number;
  price: number;
  oi: number;
  funding: number;
  dayVol: number;
}

export interface MarketSnapshot {
  venue: string;
  symbol: string;
  markPx: number;
  funding: number;
  openInterestUsd: number;
  dayVolumeUsd: number;
  ts: number;
}
