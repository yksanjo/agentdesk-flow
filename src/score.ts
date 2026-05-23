import type { FlowComponents, FlowVerdict, RawSample } from "./types.js";

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

// Score a window: signed [-100, +100].
// Direction: positive = net longs entering / capital flowing in (bullish inflow),
//            negative = net shorts entering or longs unwinding (outflow / bearish).
export function scoreWindow(
  prev: RawSample | null,
  curr: RawSample,
): { score: number | null; components: FlowComponents } {
  if (!prev || prev.ts === curr.ts) {
    return {
      score: null,
      components: {
        oiDeltaPct: 0,
        priceDeltaPct: 0,
        funding: curr.funding,
        volumeDeltaPct: 0,
      },
    };
  }

  const oiPct = prev.oi > 0 ? (curr.oi - prev.oi) / prev.oi : 0;
  const pxPct = prev.price > 0 ? (curr.price - prev.price) / prev.price : 0;
  const volPct = prev.dayVol > 0 ? (curr.dayVol - prev.dayVol) / prev.dayVol : 0;
  const funding = curr.funding;

  const dir =
    Math.abs(pxPct) > 0.0005
      ? Math.sign(pxPct)
      : funding !== 0
        ? Math.sign(funding)
        : 0;

  // Calibrated for a 5m window:
  //   OI +5%       → 60   (a "wild" 5m move is ~8-10%)
  //   Price +2%    → 80   (a strong 5m move on a major perp)
  //   Funding 0.02%/h → 16   (funding moves slowly, used as confirmation)
  const oiContrib = oiPct * dir * 1200;
  const pxContrib = pxPct * 4000;
  const fundContrib = funding * 80_000;

  const raw = 0.4 * oiContrib + 0.5 * pxContrib + 0.1 * fundContrib;
  const score = clamp(Math.round(raw), -100, 100);

  return {
    score,
    components: {
      oiDeltaPct: oiPct,
      priceDeltaPct: pxPct,
      funding,
      volumeDeltaPct: volPct,
    },
  };
}

export function verdict(score: number | null): FlowVerdict {
  if (score === null) return "NEUTRAL";
  if (score >= 60) return "STRONG_INFLOW";
  if (score >= 20) return "INFLOW";
  if (score <= -60) return "STRONG_OUTFLOW";
  if (score <= -20) return "OUTFLOW";
  return "NEUTRAL";
}
