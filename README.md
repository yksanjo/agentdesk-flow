# agentdesk-flow

> Live capital-flow indicator for crypto perps + pump.fun. CLI ticker + gauge dashboard + bot veto layer.

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen)](https://nodejs.org)
[![tsx](https://img.shields.io/badge/tsx-runtime-blue)](https://github.com/privatenumber/tsx)

**The thesis:** when capital is flowing out of a market, no entry strategy works — you lose no matter how clever you are. When capital is flowing in, you win no matter what. This tool measures that, live, across 230 Hyperliquid perps and pump.fun, and gives your bots a single function call to gate every entry.

```
AGENTDESK FLOW  ▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▼▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬  +7  MIXED  8:39:57 AM  ●
Inflow 2  Outflow 0  231 markets  snapshot 7s old  filter=all  sort=flow5m

 Market         Flow     1H    24H          OI    Funding       OIΔ      PxΔ   Verdict
 ────────────────────────────────────────────────────────────────────────────────────────
▶HL  GMT         +28    -27      ·        6.5M   -0.0048%    +1.40%   +1.09%   INFLOW
 HL  GRASS       +21     -1      ·        4.7M   +0.0013%    +0.80%   +0.83%   INFLOW
 HL  CHIP        +18     +8      ·        7.0M   -0.0084%    +0.73%   +0.74%   NEUTRAL
 HL  WLD         +17    +11      ·       18.5M   +0.0013%    +0.70%   +0.67%   NEUTRAL
 HL  NEAR        +15    -12      ·       76.0M   +0.0007%    +0.81%   +0.53%   NEUTRAL
 ...

 [q]uit  [r]efresh  [s]ort  [/]filter  [f]cycle: all  [v]veto-only  [↑↓]select
```

## What it does

- **Polls 230 Hyperliquid perps + pump.fun aggregate** every 30s
- **Scores each market `[-100, +100]`** from open-interest delta × price-delta direction × funding rate confirm
- **Two CLI views**: mop-style dense ticker (`npm run dash`) and Fear-and-Greed-style gauge (`npm run gauge`)
- **Drops `data/flow-signals.json`** every tick — bots consume it via `flowVeto()` to gate entries
- **Fail-closed by default**: if the producer is down or the snapshot is stale, every entry is vetoed. A trading bot that can't see flow shouldn't be entering.

## Quick start

```bash
git clone https://github.com/yksanjo/agentdesk-flow.git
cd agentdesk-flow
npm install

# Terminal 1: start the producer (writes data/flow-signals.json every 30s)
npm run headless

# Terminal 2: the live ticker
npm run dash

# Or run both in one terminal:
npm run dash-all
```

> First poll takes ~30s to populate the 5m flow scores (needs at least one prior sample to diff against). Real 1h and 24h scores fill in over time.

## The bot veto layer

This is the moat. Every trading bot you have should consult flow before placing an order.

```ts
import { flowVeto, marketRegime } from "@yksanjo/agentdesk-flow";

// Before every entry
const v = await flowVeto("hyperliquid", "SOL", {
  side: "long",
  minScore: 30,      // require at least +30 flow (between INFLOW and STRONG_INFLOW)
  window: "5m",       // or "1h" / "24h"
  maxAgeMs: 90_000,   // veto if snapshot is older than 90s
  failOpen: false,    // default: missing snapshot = veto (fail-closed)
});

if (!v.allow) {
  log(`vetoed: ${v.reason}`);
  return;
}

// Global circuit breaker
const regime = await marketRegime();
if (regime.net < -40) {
  log(`regime risk-off (${regime.net}) — halting all entries`);
  return;
}

// proceed with entry
```

Default fail-closed semantics are deliberate: a broken or stale flow signal halts entry until it's repaired. The cost of a missed trade is much less than the cost of entering blind during a regime change.

## Two views

### Ticker (default — `npm run dash`)

Mop-inspired dense tabular view. One-line header with inline gauge + needle marker + regime label + clock + connection dot. 25 rows below sorted by current `|flow|`. Full keyboard control:

| Key | Action |
| --- | --- |
| `q` | quit |
| `r` | force refresh |
| `s` | cycle sort: `flow5m` / `flow1h` / `flow24h` / `oi` / `symbol` |
| `/` | search by symbol |
| `f` | cycle filter: `all` / `inflow` / `outflow` / `strong` / `veto` |
| `v` | toggle veto-only (markets your bots should currently SKIP) |
| `↑↓` | move row selection cursor |

### Gauge (`npm run gauge`)

CNN Fear-and-Greed-style horizontal gradient bar with `▼` needle marker for overall market regime, per-asset mini gauges, top-movers list, and an explicit bot-veto status panel. Better for at-a-glance "should my bots be running at all right now?"

## How scoring works

Each market gets a signed score in `[-100, +100]`:

| Score range | Verdict | Color |
| --- | --- | --- |
| ≥ +60 | STRONG_INFLOW — conviction long zone | bright green |
| +20 to +60 | INFLOW — favorable for longs | green |
| -20 to +20 | NEUTRAL — no edge | yellow / dim |
| -60 to -20 | OUTFLOW — favorable for shorts, or stand aside | orange |
| ≤ -60 | STRONG_OUTFLOW — hard veto for longs | bright red |

The score combines three components:

1. **Open-interest delta** (×1200, weight 0.4) — magnitude of new positioning over the window
2. **Price delta** (×4000, weight 0.5) — which side is actually taking; gives the OI signal its direction sign
3. **Funding rate** (×80,000, weight 0.1) — confirmation; positive funding = longs crowded and paying

Direction logic handles the four quadrants:

- OI ↑ AND price ↑ → longs entering → **bullish inflow** (+)
- OI ↑ AND price ↓ → shorts entering → **bearish inflow** (-)
- OI ↓ AND price ↑ → shorts covering → squeeze (treated as +)
- OI ↓ AND price ↓ → longs liquidating → **bearish outflow** (-)

Multipliers were calibrated so that:

- A "moderate" 5m move (OI +2%, price +1%, funding +0.01%/h) scores **+30** (INFLOW)
- A "strong" 5m move (OI +5%, price +2%, funding +0.02%/h) scores **+66** (STRONG_INFLOW)
- A "wild" 5m move (OI +8%, price +4%) clamps to **+100**

Pump.fun has no perp-style OI/funding, so its score is synthesized from DexScreener aggregate metrics: total Solana pump.fun pair volume, liquidity-weighted average 1h price change, and active pair count.

## Architecture

```
producer  ─┬─→  HL info API           (every 30s, all 230 perps)
           └─→  DexScreener pump.fun   (every 30s, aggregate)
                          │
                          ▼
              data/flow-signals.json   (snapshot, atomic write)
                          │
            ┌─────────────┼─────────────┐
            ▼             ▼             ▼
         ticker         gauge        flowVeto()
         (CLI)          (CLI)        (your bots)
```

Producer and consumers are decoupled. Run the producer headless (or daemonize it with `nohup`/`pm2`/`systemd`), point as many consumers at the snapshot file as you want.

## Configuration

| Env var | Default | Description |
| --- | --- | --- |
| `FLOW_POLL_MS` | `30000` | Producer poll cadence in ms |
| `FLOW_TOP_N` | `30` | Rows in built-in leaderboard (legacy `flow:start` view) |
| `FLOW_HEADLESS` | unset | If `1`, producer runs without TUI (good for backgrounding) |
| `FLOW_FAST` | unset | If `1`, collapse 5m/1h/24h windows to 30s/2m/10m — useful for demos and dev |
| `TICKER_REFRESH_MS` | `3000` | Ticker view refresh cadence |
| `TICKER_ROWS` | `25` | Ticker visible row count |
| `DASH_REFRESH_MS` | `5000` | Gauge view refresh cadence |
| `DASH_FOCUS` | `BTC,ETH,SOL,HYPE,DOGE,PUMP.FUN` | Comma-separated watchlist for gauge view |

## Background it

```bash
# Producer in background, log to file
nohup npm run headless > data/flow-producer.log 2>&1 &
echo $! > data/flow.pid

# Stop later
kill $(cat data/flow.pid)
```

## Render a static color preview

```bash
npm run preview          # writes data/flow-ticker-preview.html
npm run preview -- --gauge   # writes data/flow-gauge-preview.html
open data/flow-ticker-preview.html
```

Useful for sharing screenshots in PRs, X posts, etc.

## Roadmap

- Add Drift / Aevo / dYdX as additional venues
- Per-token pump.fun flow (top-N hot tokens, not just venue aggregate)
- WebSocket-based real-time updates (currently REST-polling)
- Hosted feed at `flow.musicailab.com` — public landing, then x402 micropay for higher-cadence access
- Cross-venue divergence detection (when HL longs pile in but Drift dumps, that's a stronger signal)

## Why open source

The standard triad (OI + price + funding) is well-known; the implementation is nice but not a moat. The moat is the AgentDesk multi-tenant trading desk this slots into. Use this freely; if it helps your bots avoid bad regimes, that's the point.

Contributions welcome — especially additional venues and signal-validation studies.

## License

MIT © yksanjo
