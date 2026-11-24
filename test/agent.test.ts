import assert from "node:assert/strict";
import { test } from "node:test";
import { notesText, runTour, type TourEvent } from "../src/agent.js";
import { CONTEXT_TOKENS, estimateTokens } from "../src/budget.js";
import type { Fetch } from "../src/github.js";
import { ContextOverflow, type ChatRequest, type ChatResult, type LLM } from "../src/llm.js";

/** A fake GitHub: one repo whose files are given as path -> contents. */
function github(files: Record<string, string>, extra: { path: string; size: number }[] = []): { fetch: Fetch; urls: string[] } {
  const urls: string[] = [];
  const res = (body: unknown, ok = true) => ({ ok, status: ok ? 200 : 404, headers: { get: () => null }, json: async () => body, text: async () => String(body) });
  const fetch: Fetch = async (url) => {
    urls.push(url);
    if (url === "https://api.github.com/repos/o/r") return res({ name: "r", owner: { login: "o" }, default_branch: "main", description: "A demo." });
    if (url.startsWith("https://api.github.com/repos/o/r/git/trees/main")) return res({ tree: [...Object.entries(files).map(([path, c]) => ({ path, type: "blob", size: c.length })), ...extra.map((e) => ({ ...e, type: "blob" }))], truncated: false });
    const m = url.match(/^https:\/\/raw\.githubusercontent\.com\/o\/r\/main\/(.+)$/);
    if (m) {
      const p = decodeURIComponent(m[1]!);
      return p in files ? res(files[p]) : res("", false);
    }
    return res("", false);
  };
  return { fetch, urls };
}

/** A scripted model: answers by purpose, records every request. */
class Script implements LLM {
  readonly model = "fake";
  requests: ChatRequest[] = [];
  constructor(private answer: (req: ChatRequest, n: number) => string | Error) {}
  async chat(req: ChatRequest, onToken?: (s: string) => void): Promise<ChatResult> {
    this.requests.push(req);
    const a = this.answer(req, this.requests.length);
    if (a instanceof Error) throw a;
    onToken?.(a.slice(0, 3));
    return { text: a, finish: "stop", usage: { promptTokens: estimateTokens(req.messages.map((m) => m.content).join("")), completionTokens: 20, prefillTokensPerS: 500, decodeTokensPerS: 30, seconds: 0.5 } };
  }
}

const kind = (req: ChatRequest) => (!req.schema ? "write" : JSON.stringify(req.schema).includes('"enum"') ? "pick" : "notes");
const enumOf = (req: ChatRequest) => (req.schema as any).properties.next.enum as string[];

const FILES = {
  "README.md": "# r\n\nA demo repo.",
  "package.json": '{"name":"r"}',
  "src/index.ts": "export const a = 1;",
  "src/agent.ts": "export function run() {}",
  "test/agent.test.ts": "test()",
};

test("reads the README first, then lets the model choose; DONE is only allowed after two files", async () => {
  const gh = github(FILES);
  const picks = ["package.json", "src/index.ts", "DONE"];
  const llm = new Script((req) => {
    const k = kind(req);
    if (k === "notes") return JSON.stringify({ role: "a file", notes: ["fact one", "fact two"] });
    if (k === "pick") return JSON.stringify({ thought: "next", next: picks.shift() });
    return "## What it is\n\nStart at `src/index.ts`, then `src/made-up.ts`.";
  });
  const events: TourEvent[] = [];
  const out = await runTour({ ref: { owner: "o", name: "r" }, llm, fetch: gh.fetch, onEvent: (e) => events.push(e) });

  assert.deepEqual(out.read, ["README.md", "package.json", "src/index.ts"]);
  const pickReqs = llm.requests.filter((r) => kind(r) === "pick");
  assert.ok(!enumOf(pickReqs[0]!).includes("DONE"), "can't stop after one file");
  assert.ok(!enumOf(pickReqs[0]!).includes("README.md"), "can't re-read a file");
  assert.ok(enumOf(pickReqs[1]!).includes("DONE"));
  assert.deepEqual(out.checks.map((c) => `${c.path}:${c.status}`), ["src/index.ts:read", "src/made-up.ts:missing"]);
  assert.equal(out.calls.length, 3 + 3 + 1);
  assert.deepEqual([...new Set(events.map((e) => e.type))].sort(), ["call", "called", "done", "notes", "pick", "read", "repo", "token"]);
  // Two GitHub API calls in all; file contents come from raw.githubusercontent.com.
  assert.equal(gh.urls.filter((u) => u.startsWith("https://api.github.com")).length, 2);
});

test("a malformed pick falls back to the top-ranked file instead of failing", async () => {
  const gh = github(FILES);
  let picks = 0;
  const llm = new Script((req) => (kind(req) === "pick" ? (picks++ === 0 ? '{"thought": "cut off' : JSON.stringify({ thought: "", next: "DONE" })) : kind(req) === "notes" ? '{"role":"x","notes":[]}' : "done"));
  const events: TourEvent[] = [];
  const out = await runTour({ ref: { owner: "o", name: "r" }, llm, fetch: gh.fetch, onEvent: (e) => events.push(e) });
  const fb = events.find((e) => e.type === "pick" && e.fallback) as Extract<TourEvent, { type: "pick" }>;
  assert.equal(fb.next, "package.json");
  assert.equal(fb.fallback, "answer didn't parse");
  assert.deepEqual(out.read, ["README.md", "package.json"]);
});

test("a file that overflows the context is retried with half as much of it", async () => {
  const gh = github({ ...FILES, "README.md": "x\n".repeat(20000) });
  let overflowed = false;
  const llm = new Script((req) => {
    if (kind(req) === "notes" && !overflowed) {
      overflowed = true;
      return new ContextOverflow("too long");
    }
    if (kind(req) === "pick") return JSON.stringify({ thought: "", next: "DONE" });
    return kind(req) === "notes" ? '{"role":"readme","notes":["n"]}' : "ok";
  });
  const events: TourEvent[] = [];
  await runTour({ ref: { owner: "o", name: "r" }, llm, fetch: gh.fetch, maxReads: 1, onEvent: (e) => events.push(e) });
  const notesReqs = llm.requests.filter((r) => kind(r) === "notes");
  assert.equal(notesReqs.length, 2);
  assert.ok(notesReqs[1]!.messages[1]!.content.length < notesReqs[0]!.messages[1]!.content.length * 0.6);
  assert.ok(events.some((e) => e.type === "retry"));
});

test("on a big repo with big files, every prompt plus its answer fits in 4,096 tokens", async () => {
  const big: Record<string, string> = { "README.md": "# big\n" + "Some words about the project. ".repeat(3000) };
  for (let i = 0; i < 300; i++) big[`src/module${i}/very/long/path/name/file_number_${i}.ts`] = "export const x = 1;\n".repeat(800);
  const gh = github(big);
  let n = 0;
  const llm = new Script((req) => {
    if (kind(req) === "pick") return JSON.stringify({ thought: "next", next: enumOf(req).find((p) => p !== "DONE") });
    if (kind(req) === "notes") return JSON.stringify({ role: "a long role sentence ".repeat(6), notes: Array(4).fill(`a long note about this file ${n++} `.repeat(4)) });
    return "ok";
  });
  await runTour({ ref: { owner: "o", name: "r" }, llm, fetch: gh.fetch, maxReads: 5 });
  for (const req of llm.requests) {
    const used = estimateTokens(req.messages.map((m) => m.content).join("\n")) + req.maxTokens + 60;
    assert.ok(used <= CONTEXT_TOKENS, `${kind(req)} call needs ${used} tokens`);
  }
});

test("older notes shrink to one line so the newest stay whole", () => {
  const notes = Array.from({ length: 6 }, (_, i) => ({ path: `f${i}.ts`, role: `role ${i}`, notes: ["x".repeat(400), "y".repeat(400)] }));
  const text = notesText(notes, 500);
  assert.ok(estimateTokens(text) <= 500);
  assert.match(text, /- f0\.ts: role 0\n- f1\.ts/);
  assert.match(text, /- f5\.ts: role 5\n  - x{400}/);
});

test("a repo with nothing readable fails with a clear message", async () => {
  const gh = github({}, [{ path: "logo.png", size: 100 }]);
  await assert.rejects(runTour({ ref: { owner: "o", name: "r" }, llm: new Script(() => "x"), fetch: gh.fetch }), /no source or text files/);
});
