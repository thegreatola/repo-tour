/**
 * Recorded runs, for visitors without WebGPU. A recording is the event stream of
 * a real run in a real browser, minus the per-token events; playback re-creates
 * the streaming from each call's final text and its measured duration.
 */
import type { TourEvent } from "./agent.js";

export interface Recording {
  version: 1;
  repo: string;
  model: string;
  /** What it ran on, in the recorder's words, e.g. "MacBook, Apple M-series GPU, Chrome". */
  device: string;
  recordedAt: string;
  load: { seconds: number; fromCache: boolean };
  events: { t: number; e: TourEvent }[];
}

export class Recorder {
  private start = performance.now();
  events: Recording["events"] = [];
  push(e: TourEvent) {
    if (e.type === "token") return;
    this.events.push({ t: Math.round(performance.now() - this.start), e });
  }
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted || ms <= 0) return resolve();
    const id = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(id), resolve()), { once: true });
  });

/** Play a recording back at `speed` times real time. Streaming is simulated between each call's start and end. */
export async function replay(rec: Recording, onEvent: (e: TourEvent) => void, opts: { speed?: number; signal?: AbortSignal } = {}): Promise<void> {
  const speed = opts.speed ?? 1;
  const evs = rec.events;
  let now = 0;
  for (let i = 0; i < evs.length; i++) {
    if (opts.signal?.aborted) return;
    const { t, e } = evs[i]!;
    await sleep((t - now) / speed, opts.signal);
    now = t;
    onEvent(e);
    if (e.type === "call") {
      const endIdx = evs.findIndex((x, j) => j > i && x.e.type === "called");
      if (endIdx < 0) continue;
      const end = evs[endIdx]!;
      const text = (end.e as Extract<TourEvent, { type: "called" }>).text;
      const span = Math.max(1, end.t - t);
      const frames = Math.max(1, Math.min(60, Math.floor(span / speed / 50)));
      for (let f = 1; f < frames; f++) {
        await sleep(span / frames / speed, opts.signal);
        if (opts.signal?.aborted) return;
        onEvent({ type: "token", purpose: e.purpose, text: text.slice(0, Math.floor((text.length * f) / frames)) });
      }
      now = t + Math.floor((span * (frames - 1)) / frames);
    }
  }
}
