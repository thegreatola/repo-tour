/**
 * A small Markdown renderer for the walkthrough. Everything is escaped first,
 * so model output can never inject HTML. File paths in backticks are marked by
 * the grounding check: read, exists but unread, or not in the repo.
 */
import type { PathCheck } from "./ground.js";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function inline(s: string, checks: Map<string, PathCheck["status"]>): string {
  return esc(s)
    .replace(/`([^`]+)`/g, (_, code: string) => {
      const raw = code.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/^\.\//, "").replace(/[.,:;]+$/, "");
      const status = checks.get(raw);
      if (status === "missing") return `<code class="path missing" title="Not in this repo: the model made this up">${code}</code>`;
      if (status === "read") return `<code class="path read" title="The agent read this file">${code}</code>`;
      if (status === "exists") return `<code class="path" title="In the repo, but the agent didn't read it">${code}</code>`;
      return `<code>${code}</code>`;
    })
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(?<![\w*])\*([^*\n]+)\*(?![\w*])/g, "<em>$1</em>");
}

export function renderMarkdown(md: string, checks: PathCheck[] = []): string {
  const map = new Map(checks.map((c) => [c.path, c.status]));
  const out: string[] = [];
  let list: "ul" | "ol" | null = null;
  let para: string[] = [];
  const flushPara = () => {
    if (para.length) out.push(`<p>${inline(para.join(" "), map)}</p>`);
    para = [];
  };
  const closeList = () => {
    if (list) out.push(`</${list}>`);
    list = null;
  };
  for (const raw of md.replace(/\r/g, "").split("\n")) {
    const line = raw.trimEnd();
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    const ul = line.match(/^\s*[-*]\s+(.*)$/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (!line.trim()) {
      flushPara();
      closeList();
    } else if (h) {
      flushPara();
      closeList();
      const level = Math.min(4, Math.max(2, h[1]!.length + 1));
      out.push(`<h${level}>${inline(h[2]!, map)}</h${level}>`);
    } else if (ul || ol) {
      flushPara();
      const kind = ul ? "ul" : "ol";
      if (list !== kind) {
        closeList();
        out.push(`<${kind}>`);
        list = kind;
      }
      out.push(`<li>${inline((ul ?? ol)![1]!, map)}</li>`);
    } else {
      closeList();
      para.push(line.trim());
    }
  }
  flushPara();
  closeList();
  return out.join("\n");
}
