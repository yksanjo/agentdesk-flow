import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { RawSample } from "./types.js";

const MAX_SAMPLES = 360;
const STATE_PATH = "data/flow-state.json";

export class FlowState {
  private buf = new Map<string, RawSample[]>();

  key(venue: string, symbol: string): string {
    return `${venue}:${symbol}`;
  }

  push(venue: string, symbol: string, sample: RawSample): void {
    const k = this.key(venue, symbol);
    const arr = this.buf.get(k) ?? [];
    arr.push(sample);
    if (arr.length > MAX_SAMPLES) arr.shift();
    this.buf.set(k, arr);
  }

  latest(venue: string, symbol: string): RawSample | null {
    const arr = this.buf.get(this.key(venue, symbol));
    return arr && arr.length ? arr[arr.length - 1] : null;
  }

  near(venue: string, symbol: string, ts: number): RawSample | null {
    const arr = this.buf.get(this.key(venue, symbol));
    if (!arr || !arr.length) return null;
    let best: RawSample | null = null;
    for (const s of arr) {
      if (s.ts > ts) break;
      best = s;
    }
    return best;
  }

  async persist(): Promise<void> {
    await mkdir(dirname(STATE_PATH), { recursive: true });
    const obj: Record<string, RawSample[]> = {};
    for (const [k, v] of this.buf.entries()) obj[k] = v;
    await writeFile(STATE_PATH, JSON.stringify(obj));
  }

  async restore(): Promise<void> {
    try {
      const raw = await readFile(STATE_PATH, "utf8");
      const obj = JSON.parse(raw) as Record<string, RawSample[]>;
      for (const [k, v] of Object.entries(obj)) this.buf.set(k, v);
    } catch {
      // first run — no prior state
    }
  }
}
