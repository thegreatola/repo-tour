/**
 * What the agent can see of a repo: its file list, filtered down to files worth
 * reading and ranked so the best candidates fit in a small model's context.
 */

export interface RepoRef {
  owner: string;
  name: string;
}

export interface RepoFile {
  path: string;
  size: number;
}

export interface RepoInfo extends RepoRef {
  branch: string;
  description: string;
  files: RepoFile[];
  /** True when GitHub cut the file list short (very large repos). */
  truncated: boolean;
}

/** Accepts owner/name, github.com/owner/name, or a full URL with extra path. */
export function parseRepo(input: string): RepoRef | null {
  const s = input.trim().replace(/\.git$/, "").replace(/\/+$/, "");
  const m = s.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)(?:\/.*)?$/i) ?? s.match(/^([\w.-]+)\/([\w.-]+)$/);
  if (!m) return null;
  const [owner, name] = [m[1]!, m[2]!];
  if (owner.startsWith(".") || name.startsWith(".")) return null;
  return { owner, name };
}

const SKIP_DIRS = /(^|\/)(node_modules|vendor|third_party|dist|build|out|target|\.next|\.git|\.github|coverage|__pycache__|\.venv|venv|bower_components|Pods|DerivedData)\//i;
const SKIP_FILES = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb|Cargo\.lock|poetry\.lock|Gemfile\.lock|composer\.lock|go\.sum|\.DS_Store|LICENSE(\.\w+)?|CHANGELOG(\.\w+)?)$/i;
const TEXT_EXT = /\.(md|mdx|txt|rst|ts|tsx|js|jsx|mjs|cjs|py|go|rs|rb|java|kt|swift|c|h|cc|cpp|hpp|cs|php|scala|ex|exs|clj|lua|sh|zsh|sql|graphql|proto|toml|yaml|yml|json|ini|cfg|html|css|scss|vue|svelte|astro|dart|zig|nim|r|jl)$/i;
const NAMED_TEXT = /(^|\/)(Dockerfile|Makefile|Procfile|Gemfile|Rakefile|Justfile)$/;
/** Over this, a file is probably generated data, not code a person reads. */
export const MAX_FILE_BYTES = 200_000;

export function readable(f: RepoFile): boolean {
  if (SKIP_DIRS.test(f.path) || SKIP_FILES.test(f.path)) return false;
  if (!TEXT_EXT.test(f.path) && !NAMED_TEXT.test(f.path)) return false;
  if (/\.min\.(js|css)$/.test(f.path) || /(^|\/)fixtures?\//.test(f.path)) return false;
  return f.size > 0 && f.size <= MAX_FILE_BYTES;
}

const MANIFEST = /^(package\.json|pyproject\.toml|setup\.py|Cargo\.toml|go\.mod|pom\.xml|build\.gradle(\.kts)?|Gemfile|composer\.json|mix\.exs|deno\.json|Package\.swift)$/;
const ENTRY = /(^|\/)(index|main|app|cli|server|mod|lib|__main__|__init__|program|handler)\.\w+$/i;

/** Higher is more worth reading first. Pure, so the ranking is tested. */
export function score(path: string): number {
  const depth = path.split("/").length - 1;
  const base = path.split("/").pop()!;
  let s = 10 - Math.min(depth, 6) * 1.5;
  if (/^readme(\.\w+)?$/i.test(base)) s += depth === 0 ? 100 : 5;
  if (depth === 0 && MANIFEST.test(base)) s += 40;
  if (ENTRY.test(path)) s += 12;
  if (/^(src|lib|app|cmd|pkg|internal)\//.test(path)) s += 6;
  if (/(^|\/)(docs?)\//i.test(path) && /\.mdx?$/i.test(path)) s += 3;
  if (/(^|\/)(tests?|__tests__|spec|e2e)\/|\.(test|spec)\.\w+$|_test\.\w+$/i.test(path)) s -= 6;
  if (/(^|\/)(examples?|scripts?|benchmarks?)\//i.test(path)) s -= 3;
  if (/\.(json|ya?ml|toml|ini|cfg|lock)$/i.test(path) && !MANIFEST.test(base)) s -= 4;
  if (/(^|\/)\.[^/]+$/.test(path)) s -= 5;
  return s;
}

export function rankFiles(files: RepoFile[]): RepoFile[] {
  return files.filter(readable).sort((a, b) => score(b.path) - score(a.path) || a.path.localeCompare(b.path));
}

export function findReadme(files: RepoFile[]): RepoFile | undefined {
  return files.find((f) => /^readme(\.(md|mdx|rst|txt))?$/i.test(f.path));
}

/** A compact outline of the repo: top-level folders with file counts, for the final write-up. */
export function outline(files: RepoFile[], limit = 14): string {
  const counts = new Map<string, number>();
  for (const f of files.filter(readable)) {
    const top = f.path.includes("/") ? f.path.split("/")[0] + "/" : f.path;
    counts.set(top, (counts.get(top) ?? 0) + 1);
  }
  const rows = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const shown = rows.slice(0, limit).map(([p, n]) => (p.endsWith("/") ? `${p} (${n} files)` : p));
  if (rows.length > limit) shown.push(`...and ${rows.length - limit} more`);
  return shown.join("\n");
}
