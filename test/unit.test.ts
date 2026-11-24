import assert from "node:assert/strict";
import { test } from "node:test";
import { prebuiltAppConfig } from "@mlc-ai/web-llm";
import { CHARS_PER_TOKEN, clip } from "../src/budget.js";
import { GitHubError, fetchRepo, type Fetch } from "../src/github.js";
import { checkPaths, pathsIn } from "../src/ground.js";
import { renderMarkdown } from "../src/markdown.js";
import { MODELS, VRAM_MB } from "../src/models.js";
import { outline, parseRepo, rankFiles, readable } from "../src/repo.js";
import { Recorder, replay, type Recording } from "../src/replay.js";

test("parseRepo takes owner/name and github.com links, and nothing else", () => {
  for (const s of ["thegreatola/launch-crew", "https://github.com/thegreatola/launch-crew", "github.com/thegreatola/launch-crew/tree/main/src", "https://github.com/thegreatola/launch-crew.git", " thegreatola/launch-crew/ "])
    assert.deepEqual(parseRepo(s), { owner: "thegreatola", name: "launch-crew" }, s);
  for (const s of ["", "launch-crew", "https://gitlab.com/a/b", "a/b/c", "../etc", "javascript:alert(1)"]) assert.equal(parseRepo(s), null, s);
});

test("the file list leaves out lockfiles, vendored code, build output, binaries and huge files", () => {
  const keep = ["README.md", "src/index.ts", "Dockerfile", "cmd/server/main.go"];
  const drop = ["package-lock.json", "node_modules/x/index.js", "dist/app.js", "logo.png", "vendor/lib.go", "app.min.js", "test/fixtures/big.json", ".github/workflows/ci.yml"];
  for (const p of keep) assert.ok(readable({ path: p, size: 100 }), p);
  for (const p of drop) assert.ok(!readable({ path: p, size: 100 }), p);
  assert.ok(!readable({ path: "src/data.ts", size: 500_000 }));
});

test("ranking puts the README, then the manifest and entry points, above tests and config", () => {
  const files = ["test/agent.test.ts", "src/agent.ts", "README.md", "package.json", "src/index.ts", "docs/guide.md", "tsconfig.json", "scripts/build.sh", "src/deep/a/b/c/util.ts"].map((path) => ({ path, size: 1000 }));
  const order = rankFiles(files).map((f) => f.path);
  assert.deepEqual(order.slice(0, 3), ["README.md", "package.json", "src/index.ts"]);
  assert.ok(order.indexOf("src/agent.ts") < order.indexOf("test/agent.test.ts"));
  assert.ok(order.indexOf("src/agent.ts") < order.indexOf("tsconfig.json"));
});

test("outline counts files per top-level folder", () => {
  const o = outline(["src/a.ts", "src/b.ts", "test/a.test.ts", "README.md", "logo.png"].map((path) => ({ path, size: 10 })));
  assert.equal(o, "src/ (2 files)\nREADME.md\ntest/ (1 files)");
});

test("clip keeps the top of a file on a line boundary and says how much is cut", () => {
  const text = Array.from({ length: 400 }, (_, i) => `line ${i} of the file`).join("\n");
  const { text: out, clipped } = clip(text, 100);
  assert.ok(clipped);
  assert.ok(out.length <= 100 * CHARS_PER_TOKEN + 40);
  assert.match(out, /^line 0 of the file\n/);
  assert.match(out, /\[\.\.\. \d+ more lines not shown\]$/);
  assert.deepEqual(clip("short", 100), { text: "short", clipped: false });
});

test("path checking: read, real but unread, and made up", () => {
  const files = ["src/agent.ts", "src/repo.ts", "README.md", "test/unit.test.ts"].map((path) => ({ path, size: 10 }));
  const text = "Start in `src/agent.ts`, then `repo.ts`. Config lives in `src/config.ts` and tests in test/. See https://x.com/a/b and `npm test`.";
  assert.deepEqual(pathsIn(text), ["src/agent.ts", "repo.ts", "src/config.ts", "test/"]);
  assert.deepEqual(checkPaths(text, files, ["src/agent.ts"]).map((c) => `${c.path}:${c.status}`), ["src/agent.ts:read", "repo.ts:exists", "src/config.ts:missing", "test/:exists"]);
});

test("markdown is escaped before it's formatted, and paths are marked", () => {
  const html = renderMarkdown("## What <b>it</b> is\n\nRuns `src/a.ts` and `src/nope.ts`. **Bold** <script>alert(1)</script>\n\n- one\n- two\n\n1. first", [
    { path: "src/a.ts", status: "read" },
    { path: "src/nope.ts", status: "missing" },
  ]);
  assert.ok(!html.includes("<script>") && !html.includes("<b>"));
  assert.match(html, /<h3>What &lt;b&gt;it&lt;\/b&gt; is<\/h3>/);
  assert.match(html, /<code class="path read"[^>]*>src\/a\.ts<\/code>/);
  assert.match(html, /<code class="path missing"[^>]*>src\/nope\.ts<\/code>/);
  assert.match(html, /<strong>Bold<\/strong>/);
  assert.match(html, /<ul>\n<li>one<\/li>\n<li>two<\/li>\n<\/ul>\n<ol>\n<li>first<\/li>\n<\/ol>/);
});

const res = (status: number, body: unknown, headers: Record<string, string> = {}) => ({ ok: status < 300, status, headers: { get: (k: string) => headers[k.toLowerCase()] ?? null }, json: async () => body, text: async () => String(body) });

test("GitHub errors say what to do", async () => {
  const notFound: Fetch = async () => res(404, {});
  await assert.rejects(fetchRepo({ owner: "a", name: "b" }, notFound), /doesn't exist, or it's private/);
  const limited: Fetch = async () => res(403, {}, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 600) });
  await assert.rejects(fetchRepo({ owner: "a", name: "b" }, limited), (e: Error) => e instanceof GitHubError && /60 API requests an hour.*about 10 min/.test(e.message));
});

test("the hard-coded GPU memory figures match the installed WebLLM", () => {
  for (const m of MODELS)
    for (const id of [m.f16, m.f32]) {
      const real = prebuiltAppConfig.model_list.find((x) => x.model_id === id);
      assert.ok(real, `${id} is in WebLLM's model list`);
      assert.equal(VRAM_MB[id], real!.vram_required_MB, id);
      assert.equal(real!.overrides?.context_window_size, 4096, `${id} has the 4,096-token window the budget assumes`);
    }
});

test("recordings drop token events, and replay streams each call's text back", async () => {
  const r = new Recorder();
  r.push({ type: "call", purpose: "write" });
  r.push({ type: "token", purpose: "write", text: "Hel" });
  r.push({ type: "called", text: "Hello world", record: { purpose: "write", promptTokens: 10, completionTokens: 2, prefillTokensPerS: 1, decodeTokensPerS: 1, seconds: 1 } });
  assert.deepEqual(r.events.map((x) => x.e.type), ["call", "called"]);
  const rec: Recording = { version: 1, repo: "a/b", model: "m", device: "d", recordedAt: "2026-11-24", load: { seconds: 1, fromCache: true }, events: [{ t: 0, e: r.events[0]!.e }, { t: 400, e: r.events[1]!.e }] };
  const seen: string[] = [];
  await replay(rec, (e) => seen.push(e.type === "token" ? `token:${e.text}` : e.type), { speed: 2 });
  assert.equal(seen[0], "call");
  assert.equal(seen.at(-1), "called");
  assert.ok(seen.some((s) => s.startsWith("token:")));
});
