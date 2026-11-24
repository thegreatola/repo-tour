/**
 * The browser side of the model: WebLLM running in a Web Worker on WebGPU.
 * Weights download once from Hugging Face and stay in the browser's cache.
 */
import { CreateWebWorkerMLCEngine, hasModelInCache, type InitProgressReport, type WebWorkerMLCEngine } from "@mlc-ai/web-llm";
import { ContextOverflow, type ChatRequest, type ChatResult, type LLM } from "./llm.js";

export const isCached = (id: string) => hasModelInCache(id).catch(() => false);

export class WebLLM implements LLM {
  private constructor(readonly model: string, private engine: WebWorkerMLCEngine) {}

  static async load(model: string, onProgress: (r: InitProgressReport) => void): Promise<WebLLM> {
    const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    const engine = await CreateWebWorkerMLCEngine(worker, model, { initProgressCallback: onProgress });
    return new WebLLM(model, engine);
  }

  async chat(req: ChatRequest, onToken?: (soFar: string) => void): Promise<ChatResult> {
    const started = performance.now();
    let text = "";
    let finish: ChatResult["finish"] = "other";
    let usage: any;
    try {
      const stream = await this.engine.chat.completions.create({
        messages: req.messages,
        max_tokens: req.maxTokens,
        temperature: req.temperature ?? 0,
        stream: true,
        stream_options: { include_usage: true },
        ...(req.schema ? { response_format: { type: "json_object" as const, schema: JSON.stringify(req.schema) } } : {}),
      });
      for await (const chunk of stream) {
        const choice = chunk.choices[0];
        if (choice?.delta?.content) {
          text += choice.delta.content;
          onToken?.(text);
        }
        if (choice?.finish_reason) finish = choice.finish_reason === "stop" ? "stop" : choice.finish_reason === "length" ? "length" : "other";
        if (chunk.usage) usage = chunk.usage;
      }
    } catch (err) {
      const e = err as Error;
      if (e.name === "ContextWindowSizeExceededError" || /context window size/i.test(e.message)) throw new ContextOverflow(e.message);
      throw err;
    }
    return {
      text,
      finish,
      usage: {
        promptTokens: usage?.prompt_tokens ?? 0,
        completionTokens: usage?.completion_tokens ?? 0,
        prefillTokensPerS: usage?.extra?.prefill_tokens_per_s ?? 0,
        decodeTokensPerS: usage?.extra?.decode_tokens_per_s ?? 0,
        seconds: (performance.now() - started) / 1000,
      },
    };
  }
}
