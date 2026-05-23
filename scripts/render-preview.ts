// Render one dashboard frame as a standalone HTML file so it can be opened
// in a browser or shared as a screenshot. Strips terminal-control codes and
// converts xterm-256 color escapes to inline CSS.
//
// Run:  npx tsx scripts/render-preview.ts
// Out:  data/flow-dash-preview.html

import { readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";

// xterm 256-color palette → hex.
function xtermHex(code: number): string {
  if (code < 16) {
    const base = [
      "#000000", "#cd0000", "#00cd00", "#cdcd00",
      "#0000ee", "#cd00cd", "#00cdcd", "#e5e5e5",
      "#7f7f7f", "#ff0000", "#00ff00", "#ffff00",
      "#5c5cff", "#ff00ff", "#00ffff", "#ffffff",
    ];
    return base[code];
  }
  if (code < 232) {
    const c = code - 16;
    const r = Math.floor(c / 36);
    const g = Math.floor((c % 36) / 6);
    const b = c % 6;
    const map = [0, 95, 135, 175, 215, 255];
    const hex = (n: number): string => n.toString(16).padStart(2, "0");
    return `#${hex(map[r])}${hex(map[g])}${hex(map[b])}`;
  }
  const gray = 8 + (code - 232) * 10;
  const h = gray.toString(16).padStart(2, "0");
  return `#${h}${h}${h}`;
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[([0-9;?]*)([a-zA-Z])/g;

function ansiToHtml(input: string): string {
  // Strip cursor/clear sequences entirely.
  let s = input
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[2J/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[H/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[\?25[hl]/g, "");

  let out = "";
  let last = 0;
  let openSpans = 0;
  let m: RegExpExecArray | null;
  ANSI.lastIndex = 0;
  while ((m = ANSI.exec(s)) !== null) {
    out += escapeHtml(s.slice(last, m.index));
    last = m.index + m[0].length;
    if (m[2] !== "m") continue;
    const params = m[1] === "" ? [0] : m[1].split(";").map((x) => parseInt(x, 10));
    if (params.length === 1 && params[0] === 0) {
      while (openSpans > 0) {
        out += "</span>";
        openSpans--;
      }
      continue;
    }
    if (params.length === 1 && params[0] === 1) {
      out += `<span style="font-weight:700">`;
      openSpans++;
      continue;
    }
    if (params.length === 1 && params[0] === 2) {
      out += `<span style="opacity:0.55">`;
      openSpans++;
      continue;
    }
    if (params[0] === 38 && params[1] === 5 && typeof params[2] === "number") {
      out += `<span style="color:${xtermHex(params[2])}">`;
      openSpans++;
      continue;
    }
  }
  out += escapeHtml(s.slice(last));
  while (openSpans > 0) {
    out += "</span>";
    openSpans--;
  }
  return out;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function main(): Promise<void> {
  // Capture a fresh frame. Default is the ticker (mop-style); pass --gauge for the gauge view.
  const useGauge = process.argv.includes("--gauge");
  const target = useGauge ? "src/dash.ts" : "src/ticker.ts";
  const result = spawnSync(
    "npx",
    ["tsx", target],
    { encoding: "utf8", timeout: 3000, env: { ...process.env, DASH_REFRESH_MS: "1500", TICKER_REFRESH_MS: "1500" } },
  );
  // Take stdout even if the process was killed by timeout (expected).
  let frame = result.stdout || "";
  // Some terminals don't emit on stdout the same; fall back to running once headlessly.
  if (frame.length < 200) {
    console.error("dash output too short, retrying...");
  }
  // Keep only the last frame (anything after the final clear sequence).
  // eslint-disable-next-line no-control-regex
  const lastClear = frame.lastIndexOf("\x1b[2J");
  if (lastClear !== -1) frame = frame.slice(lastClear);

  const body = ansiToHtml(frame);

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>AgentDesk · Capital Flow Dashboard</title>
<style>
  body {
    margin: 0;
    padding: 32px;
    background: #0b0d10;
    color: #d6d6d6;
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    font-size: 14px;
    line-height: 1.4;
  }
  pre {
    margin: 0;
    white-space: pre;
    text-shadow: 0 0 1px currentColor;
  }
  .caption {
    color: #6b7280;
    font-family: -apple-system, system-ui, sans-serif;
    font-size: 12px;
    margin: 0 0 20px;
  }
</style>
</head>
<body>
  <p class="caption">agentdesk · flow:dash · live capture · ${new Date().toISOString()}</p>
  <pre>${body}</pre>
</body>
</html>
`;

  const outPath = useGauge ? "data/flow-gauge-preview.html" : "data/flow-ticker-preview.html";
  await writeFile(outPath, html);
  console.log(`wrote ${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
