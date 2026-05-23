// Gauge primitives — CNN Fear & Greed-style red→yellow→green bar with a
// needle marker, ported to terminal. The bar always shows the full color
// gradient; the needle position encodes the current score.

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";

// 256-color ramp from deep red → orange → yellow → lime → bright green.
// Position is 0..1 across the bar; same ramp the F&G index uses.
function rampColor(pos: number): number {
  // Five anchor colors, lerped by index zone.
  // 0.00  deep red       196
  // 0.25  orange         202
  // 0.50  yellow         226
  // 0.75  lime           154
  // 1.00  bright green   46
  if (pos < 0.2) return 196;
  if (pos < 0.35) return 202;
  if (pos < 0.45) return 208;
  if (pos < 0.55) return 226;
  if (pos < 0.65) return 190;
  if (pos < 0.8) return 154;
  return 46;
}

function fg(code: number): string {
  return `\x1b[38;5;${code}m`;
}

// Map score [-100, +100] to bar position [0, width-1].
function scoreToPos(score: number, width: number): number {
  const clamped = Math.max(-100, Math.min(100, score));
  return Math.round(((clamped + 100) / 200) * (width - 1));
}

// Render the colored gradient bar.
export function renderBar(width: number): string {
  let out = "";
  for (let i = 0; i < width; i++) {
    const pos = i / (width - 1);
    out += fg(rampColor(pos)) + "█";
  }
  return out + RESET;
}

// Render the needle line above the bar.
export function renderNeedle(score: number, width: number): string {
  const pos = scoreToPos(score, width);
  const label = `${score > 0 ? "+" : ""}${score}`;
  // Place the label centered above the needle if it fits.
  const labelStart = Math.max(0, pos - Math.floor(label.length / 2));
  const labelEnd = Math.min(width, labelStart + label.length);
  let line = " ".repeat(width);
  for (let i = labelStart; i < labelEnd; i++) {
    line = line.substring(0, i) + label[i - labelStart] + line.substring(i + 1);
  }
  // Needle on the next line
  const color = fg(rampColor(pos / (width - 1)));
  const needleLine =
    " ".repeat(pos) + color + BOLD + "▼" + RESET + " ".repeat(width - pos - 1);
  return BOLD + color + line + RESET + "\n" + needleLine;
}

// Tick labels under the bar.
export function renderTicks(width: number): string {
  const labels = ["-100", "-50", "0", "+50", "+100"];
  const positions = [
    0,
    Math.floor(width * 0.25),
    Math.floor(width * 0.5),
    Math.floor(width * 0.75),
    width - 1,
  ];
  let line = " ".repeat(width);
  for (let i = 0; i < labels.length; i++) {
    const lbl = labels[i];
    // Anchor first label flush-left, last label flush-right, center the rest.
    let start: number;
    if (i === 0) start = 0;
    else if (i === labels.length - 1) start = width - lbl.length;
    else start = Math.max(0, positions[i] - Math.floor(lbl.length / 2));
    line = line.substring(0, start) + lbl + line.substring(start + lbl.length);
  }
  return DIM + line.substring(0, width) + RESET;
}

// Zone labels under the ticks.
export function renderZones(width: number): string {
  const left = "OUTFLOW";
  const center = "NEUTRAL";
  const right = "INFLOW";
  const leftPos = Math.floor(width * 0.12);
  const centerPos = Math.floor(width * 0.5) - Math.floor(center.length / 2);
  const rightPos = width - right.length - Math.floor(width * 0.08);
  let line = " ".repeat(width);
  const place = (s: string, p: number, color: string): void => {
    for (let i = 0; i < s.length && p + i < width; i++) {
      // We embed color codes around, but the string array index is plain.
      line = line.substring(0, p + i) + s[i] + line.substring(p + i + 1);
    }
  };
  place(left, leftPos, fg(196));
  place(center, centerPos, fg(226));
  place(right, rightPos, fg(46));
  return (
    fg(196) +
    "◄ " +
    line.substring(0, centerPos).replace(/^ +/, "").trim() +
    "  " +
    DIM +
    fg(220) +
    center +
    RESET +
    "  " +
    fg(46) +
    right +
    " ►" +
    RESET
  );
}

// Compact mini-gauge for per-asset rows: short bar with inline needle.
export function renderMiniGauge(
  score: number | null,
  width: number = 25,
): string {
  if (score === null) {
    return DIM + "·".repeat(width) + RESET;
  }
  const pos = scoreToPos(score, width);
  let out = "";
  for (let i = 0; i < width; i++) {
    const fraction = i / (width - 1);
    const color = rampColor(fraction);
    if (i === pos) {
      out += BOLD + fg(color) + "◆" + RESET;
    } else if (
      (score >= 0 && i >= width / 2 && i < pos) ||
      (score < 0 && i > pos && i <= width / 2)
    ) {
      // Filled segment between center and needle gets full color
      out += fg(color) + "━" + RESET;
    } else {
      // Empty segment gets dimmed gradient
      out += DIM + fg(color) + "─" + RESET;
    }
  }
  return out;
}

// Big-number score display with verdict.
export function renderScoreBlock(score: number | null): {
  number: string;
  verdict: string;
} {
  if (score === null)
    return { number: DIM + " · " + RESET, verdict: DIM + "WAITING" + RESET };
  const pos = scoreToPos(score, 100);
  const color = fg(rampColor(pos / 99));
  const numText = (score > 0 ? "+" : "") + score;
  let verdict = "NEUTRAL";
  if (score >= 60) verdict = "STRONG INFLOW";
  else if (score >= 20) verdict = "INFLOW";
  else if (score <= -60) verdict = "STRONG OUTFLOW";
  else if (score <= -20) verdict = "OUTFLOW";
  return {
    number: BOLD + color + numText + RESET,
    verdict: BOLD + color + verdict + RESET,
  };
}

// Sparkline from recent scores.
export function renderSparkline(scores: number[]): string {
  if (!scores.length) return DIM + "·".repeat(16) + RESET;
  const chars = "▁▂▃▄▅▆▇█";
  let out = "";
  for (const s of scores) {
    const norm = (Math.max(-100, Math.min(100, s)) + 100) / 200;
    const idx = Math.min(chars.length - 1, Math.floor(norm * chars.length));
    const color = fg(rampColor(norm));
    out += color + chars[idx] + RESET;
  }
  return out;
}
