/**
 * Every model this page offers has a 4,096-token context window, and there is no
 * tokenizer until the model has loaded. So prompts are planned against a
 * conservative estimate, and the real counts the engine reports are kept for the
 * trade-offs table.
 */

export const CONTEXT_TOKENS = 4096;

/** Code tokenizes at roughly 3 to 4 characters a token. 3 errs toward fitting. */
export const CHARS_PER_TOKEN = 3;

export const estimateTokens = (s: string) => Math.ceil(s.length / CHARS_PER_TOKEN);

/** The token budget of each kind of call, chosen so the worst case still fits in 4,096. */
export const BUDGET = {
  /** Reading one file: the excerpt the model sees, and the notes it writes back. */
  fileExcerpt: 1700,
  notesOut: 220,
  /** Picking the next file: the candidate list and the notes so far. */
  candidates: 40,
  pickOut: 120,
  /** All notes together, before older ones are trimmed. */
  notes: 900,
  /** The final walkthrough. */
  finalOut: 900,
};

/**
 * Cut text to about `tokens`, on a line boundary, and say so. Code is kept from
 * the top: imports, exports and the first definitions say the most per token.
 */
export function clip(text: string, tokens: number): { text: string; clipped: boolean } {
  const max = tokens * CHARS_PER_TOKEN;
  if (text.length <= max) return { text, clipped: false };
  const cut = text.lastIndexOf("\n", max);
  const head = text.slice(0, cut > max * 0.6 ? cut : max);
  const lines = text.slice(head.length).split("\n").length - 1;
  return { text: `${head}\n[... ${lines} more lines not shown]`, clipped: true };
}
