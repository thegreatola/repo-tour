/**
 * Reads a public repo straight from the visitor's browser. Two GitHub API calls
 * per repo (metadata and the file tree); file contents come from
 * raw.githubusercontent.com, which doesn't count against the API limit of 60
 * requests an hour per visitor. There is no server in between.
 */
import type { RepoInfo, RepoRef } from "./repo.js";

export type Fetch = (url: string) => Promise<{ ok: boolean; status: number; headers: { get(name: string): string | null }; json(): Promise<any>; text(): Promise<string> }>;

export class GitHubError extends Error {}

async function api(fetch: Fetch, url: string): Promise<any> {
  const res = await fetch(url);
  if (res.ok) return res.json();
  if (res.status === 404) throw new GitHubError("That repo doesn't exist, or it's private. Only public repos can be read from the browser.");
  if ((res.status === 403 || res.status === 429) && res.headers.get("x-ratelimit-remaining") === "0") {
    const reset = Number(res.headers.get("x-ratelimit-reset"));
    const mins = reset ? Math.max(1, Math.ceil((reset * 1000 - Date.now()) / 60000)) : null;
    throw new GitHubError(`GitHub allows 60 API requests an hour from your network, and they're used up.${mins ? ` Try again in about ${mins} min.` : ""}`);
  }
  throw new GitHubError(`GitHub answered ${res.status}.`);
}

export async function fetchRepo(ref: RepoRef, fetch: Fetch): Promise<RepoInfo> {
  const base = `https://api.github.com/repos/${ref.owner}/${ref.name}`;
  const meta = await api(fetch, base);
  const branch = String(meta.default_branch ?? "main");
  const tree = await api(fetch, `${base}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
  const files = (tree.tree ?? [])
    .filter((t: any) => t.type === "blob")
    .map((t: any) => ({ path: String(t.path), size: Number(t.size ?? 0) }));
  return { owner: String(meta.owner?.login ?? ref.owner), name: String(meta.name ?? ref.name), branch, description: String(meta.description ?? ""), files, truncated: !!tree.truncated };
}

export async function fetchFile(repo: RepoInfo, path: string, fetch: Fetch): Promise<string> {
  const url = `https://raw.githubusercontent.com/${repo.owner}/${repo.name}/${encodeURIComponent(repo.branch)}/${path.split("/").map(encodeURIComponent).join("/")}`;
  const res = await fetch(url);
  if (!res.ok) throw new GitHubError(`Couldn't read ${path} (${res.status}).`);
  return res.text();
}
