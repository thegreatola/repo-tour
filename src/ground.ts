/**
 * Small models invent file names. After the walkthrough is written, every
 * path-like token in it is checked against the repo's real file list, and the
 * page marks the ones that don't exist.
 */
import type { RepoFile } from "./repo.js";

export interface PathCheck {
  path: string;
  status: "read" | "exists" | "missing";
}

const PATHISH = /`([^`\s]+)`|(?<![\w@/.])((?:[\w.-]+\/)+[\w.-]*|[\w-]+\.(?:md|ts|tsx|js|jsx|mjs|py|go|rs|rb|java|json|toml|ya?ml|sh|css|html))(?![\w/])/g;

/** Path-like strings in the text: anything in backticks with a slash or an extension, and bare a/b/c or file.ext. */
export function pathsIn(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(PATHISH)) {
    const raw = (m[1] ?? m[2] ?? "").replace(/[.,:;)]+$/, "").replace(/^\.\//, "");
    if (!raw || /^https?:/.test(raw) || /^\d/.test(raw)) continue;
    if (!raw.includes("/") && !/\.\w{1,5}$/.test(raw)) continue;
    if (/\(|\)|=|</.test(raw)) continue;
    out.add(raw);
  }
  return [...out];
}

export function checkPaths(text: string, files: RepoFile[], read: string[]): PathCheck[] {
  const all = new Set(files.map((f) => f.path));
  const dirs = new Set(files.flatMap((f) => f.path.split("/").slice(0, -1).map((_, i, a) => a.slice(0, i + 1).join("/") + "/")));
  const readSet = new Set(read);
  return pathsIn(text).map((p) => {
    if (readSet.has(p)) return { path: p, status: "read" as const };
    if (all.has(p) || dirs.has(p.endsWith("/") ? p : p + "/")) return { path: p, status: "exists" as const };
    // "index.ts" alone is fine if exactly the repo has one such file name.
    const byName = [...all].filter((f) => f.endsWith("/" + p) || f === p);
    if (byName.length) return { path: p, status: byName.some((f) => readSet.has(f)) ? ("read" as const) : ("exists" as const) };
    return { path: p, status: "missing" as const };
  });
}
