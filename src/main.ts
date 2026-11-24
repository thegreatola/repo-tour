import "./style.css";
import { runTour, type CallRecord, type TourEvent } from "./agent.js";
import { CONTEXT_TOKENS } from "./budget.js";
import type { PathCheck } from "./ground.js";
import { renderMarkdown } from "./markdown.js";
import { parseRepo } from "./repo.js";
import { Recorder, replay, type Recording } from "./replay.js";
import { MODELS, checkWebGPU, vramMB, type GpuCheck } from "./models.js";
import type { WebLLM } from "./webllm.js";

/** WebLLM is several megabytes; it loads after the page is up, or when a run starts. */
const webllm = () => import("./webllm.js");

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const form = $<HTMLFormElement>("form");
const repoInput = $<HTMLInputElement>("repo");
const modelSelect = $<HTMLSelectElement>("model");
const runButton = $<HTMLButtonElement>("run");
const formError = $<HTMLParagraphElement>("form-error");
const steps = $<HTMLOListElement>("steps");
const output = $<HTMLElement>("output");

let gpu: GpuCheck = { ok: false, f16: false };
let busy = false;
let skip: AbortController | null = null;
let lastRecording: Recording | null = null;
const loaded = new Map<string, WebLLM>();

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const secs = (s: number) => (s < 10 ? `${s.toFixed(1)} s` : s < 90 ? `${Math.round(s)} s` : `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`);
const modelId = (key: string) => {
  const m = MODELS.find((x) => x.key === key) ?? MODELS[0]!;
  return gpu.f16 ? m.f16 : m.f32;
};
const labelOf = (id: string) => MODELS.find((m) => m.f16 === id || m.f32 === id)?.label ?? id;

async function init() {
  for (const m of MODELS) modelSelect.add(new Option(m.label, m.key));
  const params = new URLSearchParams(location.search);
  if (params.get("repo")) repoInput.value = params.get("repo")!;
  if (params.get("model") && MODELS.some((m) => m.key === params.get("model"))) modelSelect.value = params.get("model")!;

  gpu = await checkWebGPU();
  const status = $<HTMLParagraphElement>("gpu");
  if (gpu.ok) {
    const { isCached } = await webllm();
    const cached = await Promise.all(MODELS.map((m) => isCached(gpu.f16 ? m.f16 : m.f32)));
    MODELS.forEach((m, i) => {
      const id = gpu.f16 ? m.f16 : m.f32;
      modelSelect.options[i]!.text = `${m.label}: ${cached[i] ? "downloaded" : `about ${(vramMB(id) / 1024).toFixed(1)} GB of GPU memory`}`;
    });
    status.textContent = `WebGPU is ready${gpu.f16 ? "" : " (without 16-bit floats, so the 32-bit builds are used)"}. The first run downloads the model, then it's cached.`;
  } else {
    status.textContent = `${gpu.reason} You can still watch a recorded run.`;
    status.classList.add("no");
    runButton.disabled = true;
  }
  await loadRecordings();
}

form.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  if (busy) return;
  const ref = parseRepo(repoInput.value);
  if (!ref) return showFormError("Enter a public GitHub repo as owner/name, or paste its github.com link.");
  showFormError(null);
  history.replaceState(null, "", `?repo=${encodeURIComponent(`${ref.owner}/${ref.name}`)}&model=${modelSelect.value}`);
  await live(`${ref.owner}/${ref.name}`, modelId(modelSelect.value));
});

function showFormError(msg: string | null) {
  formError.hidden = !msg;
  formError.textContent = msg ?? "";
  repoInput.setAttribute("aria-invalid", msg ? "true" : "false");
  if (msg) repoInput.focus();
}

async function live(repo: string, model: string) {
  busy = true;
  runButton.disabled = true;
  begin("Live, in your browser", repo, `${labelOf(model)} on your GPU`);
  const rec = new Recorder();
  const loadBox = $("load");
  const loadStarted = performance.now();
  const { WebLLM: Engine, isCached } = await webllm();
  let fromCache = await isCached(model);
  try {
    let llm = loaded.get(model);
    if (!llm) {
      loadBox.hidden = false;
      llm = await Engine.load(model, (r) => {
        $("load-fill").style.width = `${Math.round(r.progress * 100)}%`;
        $("load-text").textContent = r.text;
      });
      loaded.set(model, llm);
    } else fromCache = true;
    const loadSeconds = (performance.now() - loadStarted) / 1000;
    loadBox.hidden = true;
    const ui = view({ loadSeconds, fromCache, model });
    const ref = parseRepo(repo)!;
    await runTour({ ref, llm, fetch: (u) => fetch(u), onEvent: (e) => (rec.push(e), ui(e)) });
    lastRecording = { version: 1, repo, model, device: navigator.userAgent, recordedAt: new Date().toISOString(), load: { seconds: Math.round(loadSeconds * 10) / 10, fromCache }, events: rec.events };
    $("save").hidden = false;
    // In development, the recording is also reachable from the console, to save runs for the replay list.
    if (import.meta.env.DEV) (window as any).lastRecording = lastRecording;
  } catch (err) {
    loadBox.hidden = true;
    addStep(`<span class="what warn">Stopped</span><span class="why">${esc((err as Error).message)}</span>`);
  } finally {
    busy = false;
    runButton.disabled = !gpu.ok;
  }
}

async function play(rec: Recording) {
  if (busy) return;
  busy = true;
  skip = new AbortController();
  $("skip").hidden = false;
  begin("Recorded run", rec.repo, `${labelOf(rec.model)}, recorded ${rec.recordedAt.slice(0, 10)}. Played back at its real speed.`);
  const ui = view({ loadSeconds: rec.load.seconds, fromCache: rec.load.fromCache, model: rec.model });
  const signal = skip.signal;
  await replay(rec, ui, { speed: 1, signal });
  if (signal.aborted) {
    // Skipped: show the finished run at once.
    begin("Recorded run", rec.repo, `${labelOf(rec.model)}, recorded ${rec.recordedAt.slice(0, 10)}.`);
    const fast = view({ loadSeconds: rec.load.seconds, fromCache: rec.load.fromCache, model: rec.model });
    for (const { e } of rec.events) fast(e);
  }
  $("skip").hidden = true;
  busy = false;
}

$("skip").addEventListener("click", () => skip?.abort());
$("save").addEventListener("click", () => {
  if (!lastRecording) return;
  const blob = new Blob([JSON.stringify(lastRecording)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${lastRecording.repo.replace("/", "--")}--${lastRecording.model}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});

function begin(kind: string, repo: string, meta: string) {
  const s = $("session");
  s.hidden = false;
  $("session-kind").textContent = kind;
  $("session-title").textContent = repo;
  $("session-meta").textContent = meta;
  steps.innerHTML = "";
  output.innerHTML = '<p class="placeholder">The walkthrough appears here as it\'s written.</p>';
  $("checks").hidden = true;
  $("metrics").hidden = true;
  $("save").hidden = true;
  s.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
}

function addStep(html: string): HTMLLIElement {
  const li = document.createElement("li");
  li.innerHTML = html;
  steps.append(li);
  return li;
}

const PURPOSE: Record<CallRecord["purpose"], string> = { notes: "Taking notes on", pick: "Choosing the next file", write: "Writing the walkthrough" };

/** Returns an event handler that draws one run, live or replayed. */
function view(run: { loadSeconds: number; fromCache: boolean; model: string }) {
  let current: HTMLLIElement | null = null;
  const calls: CallRecord[] = [];
  const started = performance.now();
  let firstEventAt = 0;
  return (e: TourEvent) => {
    switch (e.type) {
      case "repo":
        $("session-meta").textContent += `. ${e.files.toLocaleString()} files on ${e.branch}, ${e.readable.toLocaleString()} worth reading${e.truncated ? " (GitHub cut the list short)" : ""}.`;
        break;
      case "call":
        if (!firstEventAt) firstEventAt = performance.now();
        if (e.purpose === "write") {
          output.innerHTML = '<p class="streaming"></p>';
          current = addStep(`<span class="what">${PURPOSE.write}</span><span class="num">thinking…</span>`);
        } else if (e.purpose === "pick") current = addStep(`<span class="what">${PURPOSE.pick}</span><span class="live"></span><span class="num">thinking…</span>`);
        else if (current && current.dataset.path === e.path) current.querySelector(".num")!.textContent = "thinking…";
        else current = addStep(`<span class="what">${PURPOSE.notes} <code>${esc(e.path ?? "")}</code></span><span class="live"></span><span class="num">thinking…</span>`);
        break;
      case "token":
        if (e.purpose === "write") output.querySelector(".streaming")!.textContent = e.text;
        else {
          const live = current?.querySelector(".live");
          if (live) live.textContent = e.text;
        }
        break;
      case "read":
        current = addStep(`<span class="what">${PURPOSE.notes} <code>${esc(e.path)}</code></span><span class="why">${(e.bytes / 1024).toFixed(1)} KB${e.clipped ? ", cut to fit the context window" : ""}</span><span class="live"></span><span class="num">thinking…</span>`);
        current.dataset.path = e.path;
        break;
      case "called": {
        calls.push(e.record);
        const r = e.record;
        const pct = Math.min(100, (r.promptTokens / CONTEXT_TOKENS) * 100);
        const num = current?.querySelector(".num");
        if (num) num.innerHTML = `${r.promptTokens.toLocaleString()} tokens in, ${r.completionTokens} out, ${secs(r.seconds)}, ${Math.round(r.decodeTokensPerS)} tokens/s <span class="ctx" title="Share of the 4,096-token context used"><i style="width:${pct.toFixed(1)}%"></i></span>`;
        break;
      }
      case "pick":
        if (current) {
          current.querySelector(".what")!.innerHTML = e.next ? `Chose <code>${esc(e.next)}</code>` : "Decided it had read enough";
          current.querySelector(".live")!.outerHTML = `<span class="why">${esc(e.thought)}${e.fallback ? ` <span class="warn">(${esc(e.fallback)}; used the top-ranked file)</span>` : ""}</span>`;
        }
        break;
      case "notes":
        if (current) {
          const live = current.querySelector(".live");
          if (live) live.outerHTML = `<span class="why">${esc(e.notes.role)}</span>`;
        }
        break;
      case "retry":
        addStep(`<span class="what warn">Retrying <code>${esc(e.path)}</code></span><span class="why">${esc(e.reason)}</span>`);
        break;
      case "done":
        output.innerHTML = renderMarkdown(e.walkthrough, e.checks);
        showChecks(e.checks);
        showMetrics(run, calls, (performance.now() - (firstEventAt || started)) / 1000);
        break;
      case "error":
        addStep(`<span class="what warn">Stopped</span><span class="why">${esc(e.message)}</span>`);
        break;
    }
  };
}

function showChecks(checks: PathCheck[]) {
  const line = $("checks");
  if (!checks.length) return;
  const n = (s: PathCheck["status"]) => checks.filter((c) => c.status === s).length;
  const missing = checks.filter((c) => c.status === "missing").map((c) => `<code>${esc(c.path)}</code>`);
  line.innerHTML = `It mentions ${checks.length} file path${checks.length === 1 ? "" : "s"}: ${n("read")} it read, ${n("exists")} it didn't read but are real, and ${missing.length ? `${missing.length} that aren't in the repo (${missing.join(", ")}), struck through above.` : "none that aren't in the repo."}`;
  line.hidden = false;
}

function showMetrics(run: { loadSeconds: number; fromCache: boolean; model: string }, calls: CallRecord[], runSeconds: number) {
  const decode = calls.map((c) => c.decodeTokensPerS).filter((x) => x > 0).sort((a, b) => a - b);
  const median = decode.length ? decode[Math.floor(decode.length / 2)]! : 0;
  const peak = Math.max(0, ...calls.map((c) => c.promptTokens + c.completionTokens));
  const items: [string, string][] = [
    [run.fromCache ? "Model load (cached)" : "Download and load", secs(run.loadSeconds)],
    ["Agent run", secs(runSeconds)],
    ["Model calls", String(calls.length)],
    ["Decode speed", `${Math.round(median)} tok/s`],
    ["Most context used", `${Math.round((peak / CONTEXT_TOKENS) * 100)}%`],
  ];
  const dl = $("metrics");
  dl.innerHTML = items.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("");
  dl.hidden = false;
}

interface RecordingEntry {
  file: string;
  rec?: Recording;
}

async function loadRecordings() {
  const box = $("replays");
  const table = $<HTMLTableElement>("tradeoff-table");
  let list: RecordingEntry[] = [];
  try {
    const res = await fetch(new URL("replays/index.json", document.baseURI));
    list = res.ok ? ((await res.json()) as string[]).map((file) => ({ file })) : [];
    await Promise.all(list.map(async (r) => (r.rec = await fetch(new URL(`replays/${r.file}`, document.baseURI)).then((x) => x.json()))));
  } catch {
    list = [];
  }
  const recs = list.map((r) => r.rec).filter((r): r is Recording => !!r);
  if (!recs.length) {
    table.innerHTML = '<tr><td class="empty">No recorded runs yet.</td></tr>';
    return;
  }
  box.innerHTML = "Watch a recorded run: " + recs.map((r, i) => `<button type="button" data-i="${i}">${esc(r.repo)} with ${esc(labelOf(r.model))}</button>`).join(", ");
  box.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => play(recs[Number(b.dataset.i)]!)));
  table.innerHTML = tradeoffRows(recs);
}

export function tradeoffRows(recs: Recording[]): string {
  const rows = recs.map((r) => {
    const calls = r.events.flatMap(({ e }) => (e.type === "called" ? [e.record] : []));
    const done = r.events.find(({ e }) => e.type === "done")?.e as Extract<TourEvent, { type: "done" }> | undefined;
    const first = r.events[0]?.t ?? 0;
    const last = r.events.at(-1)?.t ?? 0;
    const decode = calls.map((c) => c.decodeTokensPerS).sort((a, b) => a - b);
    const missing = done?.checks.filter((c) => c.status === "missing").length ?? 0;
    return `<tr><td>${esc(labelOf(r.model))}</td><td>${esc(r.repo)}</td><td class="n">${(vramMB(r.model) / 1024).toFixed(1)} GB</td><td class="n">${secs(r.load.seconds)}${r.load.fromCache ? " cached" : ""}</td><td class="n">${Math.round(decode[Math.floor(decode.length / 2)] ?? 0)} tok/s</td><td class="n">${secs((last - first) / 1000)}</td><td class="n">${done ? `${missing} of ${done.checks.length}` : "n/a"}</td></tr>`;
  });
  return `<thead><tr><th>Model</th><th>Repo</th><th>GPU memory</th><th>Load</th><th>Decode</th><th>Run</th><th>Made-up paths</th></tr></thead><tbody>${rows.join("")}</tbody>`;
}

init();
