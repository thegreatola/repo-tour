/**
 * The agent: read the README, then let the model choose which files to read,
 * one at a time, writing short notes on each, then write the walkthrough from
 * the notes. Everything is sized for a 4,096-token context window.
 *
 * The model can only choose a file that exists: its answer is decoded against a
 * JSON schema whose "next" field is an enum of real, unread paths. "DONE" joins
 * the enum only after two files are read, so it can't stop before it starts.
 */
import { BUDGET, clip, estimateTokens } from "./budget.js";
import { checkPaths, type PathCheck } from "./ground.js";
import { fetchFile, fetchRepo, type Fetch } from "./github.js";
import { ContextOverflow, type ChatResult, type LLM } from "./llm.js";
import { findReadme, outline, rankFiles, type RepoInfo, type RepoRef } from "./repo.js";

export interface FileNotes {
  path: string;
  role: string;
  notes: string[];
}

export type Purpose = "notes" | "pick" | "write";

export interface CallRecord {
  purpose: Purpose;
  path?: string;
  promptTokens: number;
  completionTokens: number;
  prefillTokensPerS: number;
  decodeTokensPerS: number;
  seconds: number;
}

export type TourEvent =
  | { type: "repo"; owner: string; name: string; branch: string; files: number; readable: number; truncated: boolean }
  | { type: "call"; purpose: Purpose; path?: string }
  | { type: "token"; purpose: Purpose; text: string }
  | { type: "called"; record: CallRecord; text: string }
  | { type: "pick"; next: string | null; thought: string; fallback?: string }
  | { type: "read"; path: string; bytes: number; clipped: boolean }
  | { type: "notes"; notes: FileNotes }
  | { type: "retry"; path: string; reason: string }
  | { type: "done"; walkthrough: string; checks: PathCheck[] }
  | { type: "error"; message: string };

export interface TourResult {
  repo: RepoInfo;
  read: string[];
  notes: FileNotes[];
  walkthrough: string;
  checks: PathCheck[];
  calls: CallRecord[];
}

export interface TourOptions {
  ref: RepoRef;
  llm: LLM;
  fetch: Fetch;
  maxReads?: number;
  onEvent?: (e: TourEvent) => void;
}

const SYSTEM_JSON = "You read source code carefully and answer only with JSON that matches the requested shape. Be specific and brief. Never invent file names.";
const SYSTEM_WRITE = "You explain codebases to developers who are new to them. You write plain, specific Markdown, and you only state what your notes support.";

export async function runTour(opts: TourOptions): Promise<TourResult> {
  const emit = opts.onEvent ?? (() => {});
  const maxReads = opts.maxReads ?? 5;
  const calls: CallRecord[] = [];

  const chat = async (purpose: Purpose, path: string | undefined, req: Parameters<LLM["chat"]>[0]): Promise<ChatResult> => {
    emit({ type: "call", purpose, path });
    const res = await opts.llm.chat(req, (text) => emit({ type: "token", purpose, text }));
    const record: CallRecord = { purpose, path, promptTokens: res.usage.promptTokens, completionTokens: res.usage.completionTokens, prefillTokensPerS: res.usage.prefillTokensPerS, decodeTokensPerS: res.usage.decodeTokensPerS, seconds: res.usage.seconds };
    calls.push(record);
    emit({ type: "called", record, text: res.text });
    return res;
  };

  try {
    const repo = await fetchRepo(opts.ref, opts.fetch);
    const ranked = rankFiles(repo.files);
    emit({ type: "repo", owner: repo.owner, name: repo.name, branch: repo.branch, files: repo.files.length, readable: ranked.length, truncated: repo.truncated });
    if (!ranked.length) throw new Error("This repo has no source or text files the agent can read.");

    const read: string[] = [];
    const notes: FileNotes[] = [];
    const readme = findReadme(repo.files);

    for (let i = 0; i < maxReads; i++) {
      let path: string | null;
      if (i === 0 && readme && ranked.some((f) => f.path === readme.path)) path = readme.path;
      else path = await pick(repo, ranked.map((f) => f.path).filter((p) => !read.includes(p)), notes, read.length, chat, emit);
      if (!path) break;
      const text = await fetchFile(repo, path, opts.fetch);
      read.push(path);
      const n = await noteFile(repo, path, text, chat, emit);
      notes.push(n);
      emit({ type: "notes", notes: n });
    }

    const walkthrough = await write(repo, notes, chat);
    const checks = checkPaths(walkthrough, repo.files, read);
    emit({ type: "done", walkthrough, checks });
    return { repo, read, notes, walkthrough, checks, calls };
  } catch (err) {
    emit({ type: "error", message: (err as Error).message });
    throw err;
  }
}

type Chat = (purpose: Purpose, path: string | undefined, req: Parameters<LLM["chat"]>[0]) => Promise<ChatResult>;

export function notesText(notes: FileNotes[], budget = BUDGET.notes): string {
  const full = (n: FileNotes) => [`- ${n.path}: ${n.role}`, ...n.notes.map((x) => `  - ${x}`)].join("\n");
  const brief = (n: FileNotes) => `- ${n.path}: ${n.role}`;
  // Newest notes stay whole; older ones shrink to one line until it all fits.
  const parts = notes.map(full);
  for (let i = 0; i < notes.length && estimateTokens(parts.join("\n")) > budget; i++) parts[i] = brief(notes[i]!);
  return parts.join("\n") || "(none yet)";
}

async function pick(repo: RepoInfo, unread: string[], notes: FileNotes[], readCount: number, chat: Chat, emit: (e: TourEvent) => void): Promise<string | null> {
  const candidates = unread.slice(0, BUDGET.candidates);
  if (!candidates.length) return null;
  const options = readCount >= 2 ? [...candidates, "DONE"] : candidates;
  const sizes = new Map(repo.files.map((f) => [f.path, f.size]));
  const list = candidates.map((p) => `${p} (${Math.max(1, Math.round((sizes.get(p) ?? 0) / 1024))} KB)`).join("\n");
  const prompt = [
    `Repo: ${repo.owner}/${repo.name}${repo.description ? `: ${repo.description}` : ""}`,
    `Notes so far:\n${notesText(notes)}`,
    `Files you can read next, most promising first:\n${list}`,
    `Choose the one file that would best explain how this project works and that the notes don't cover yet.${readCount >= 2 ? ' Answer "DONE" if the notes already explain the main parts.' : ""}`,
    'Answer with JSON: {"thought": "one short sentence", "next": "<a path from the list>"}',
  ].join("\n\n");
  const schema = { type: "object", properties: { thought: { type: "string" }, next: { type: "string", enum: options } }, required: ["thought", "next"] };
  const res = await chat("pick", undefined, { messages: [{ role: "system", content: SYSTEM_JSON }, { role: "user", content: prompt }], maxTokens: BUDGET.pickOut, schema, temperature: 0 });
  const parsed = parseJson(res.text);
  const next = typeof parsed?.next === "string" ? parsed.next : null;
  const thought = typeof parsed?.thought === "string" ? parsed.thought : "";
  if (next === "DONE" && readCount >= 2) {
    emit({ type: "pick", next: null, thought });
    return null;
  }
  if (next && candidates.includes(next)) {
    emit({ type: "pick", next, thought });
    return next;
  }
  // Constrained decoding should make this impossible; if the answer was cut off or malformed, fall back to the ranking.
  const fallback = candidates[0]!;
  emit({ type: "pick", next: fallback, thought, fallback: res.finish === "length" ? "answer cut off" : "answer didn't parse" });
  return fallback;
}

async function noteFile(repo: RepoInfo, path: string, text: string, chat: Chat, emit: (e: TourEvent) => void): Promise<FileNotes> {
  const schema = {
    type: "object",
    properties: { role: { type: "string" }, notes: { type: "array", items: { type: "string" }, maxItems: 4 } },
    required: ["role", "notes"],
  };
  let budget = BUDGET.fileExcerpt;
  for (let attempt = 0; ; attempt++) {
    const { text: excerpt, clipped } = clip(text, budget);
    if (attempt === 0) emit({ type: "read", path, bytes: text.length, clipped });
    const prompt = [
      `Repo: ${repo.owner}/${repo.name}`,
      `File: ${path}${clipped ? " (cut to fit)" : ""}\n\`\`\`\n${excerpt}\n\`\`\``,
      'Write notes for someone learning this repo. Answer with JSON: {"role": "what this file is for, in one sentence", "notes": ["up to 4 short facts: what it defines, what it uses, what uses it, anything surprising"]}',
    ].join("\n\n");
    try {
      const res = await chat("notes", path, { messages: [{ role: "system", content: SYSTEM_JSON }, { role: "user", content: prompt }], maxTokens: BUDGET.notesOut, schema, temperature: 0 });
      const parsed = parseJson(res.text);
      return {
        path,
        role: typeof parsed?.role === "string" && parsed.role.trim() ? parsed.role.trim() : "(the model's notes on this file didn't parse)",
        notes: Array.isArray(parsed?.notes) ? parsed.notes.filter((x: unknown) => typeof x === "string" && x.trim()).slice(0, 4) : [],
      };
    } catch (err) {
      if (err instanceof ContextOverflow && attempt < 2) {
        budget = Math.floor(budget / 2);
        emit({ type: "retry", path, reason: `didn't fit in the context window; retrying with ${budget} tokens of the file` });
        continue;
      }
      throw err;
    }
  }
}

async function write(repo: RepoInfo, notes: FileNotes[], chat: Chat): Promise<string> {
  const prompt = [
    `Repo: ${repo.owner}/${repo.name}${repo.description ? `: ${repo.description}` : ""}`,
    `Layout (top-level folders):\n${outline(repo.files)}`,
    `Notes from the files you read:\n${notesText(notes)}`,
    [
      "Write a walkthrough of this repo for a developer opening it for the first time, in Markdown, under 350 words, with these sections:",
      "## What it is",
      "## How it's laid out",
      "## Where to start reading (three files, and why each)",
      "## What I didn't read",
      "Write file paths exactly as they appear above, in backticks. Only say what the notes support. If something is unclear, say so instead of guessing.",
    ].join("\n"),
  ].join("\n\n");
  const res = await chat("write", undefined, { messages: [{ role: "system", content: SYSTEM_WRITE }, { role: "user", content: prompt }], maxTokens: BUDGET.finalOut, temperature: 0.3 });
  return res.text.trim();
}

function parseJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      return JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
}
