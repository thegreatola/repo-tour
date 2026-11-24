/**
 * The models on offer and the WebGPU check. Kept apart from WebLLM itself so the
 * page can render before the multi-megabyte library loads.
 */

export interface ModelChoice {
  key: string;
  label: string;
  /** Model ids for GPUs with and without 16-bit float support. */
  f16: string;
  f32: string;
  blurb: string;
}

/** GPU memory each build needs, in MB, from WebLLM's prebuilt config. A test checks these match the installed version. */
export const VRAM_MB: Record<string, number> = {
  "Qwen2.5-1.5B-Instruct-q4f16_1-MLC": 1629.75,
  "Qwen2.5-1.5B-Instruct-q4f32_1-MLC": 1888.97,
  "Qwen2.5-3B-Instruct-q4f16_1-MLC": 2504.76,
  "Qwen2.5-3B-Instruct-q4f32_1-MLC": 2893.64,
  "Llama-3.2-1B-Instruct-q4f16_1-MLC": 879.04,
  "Llama-3.2-1B-Instruct-q4f32_1-MLC": 1128.82,
};

export const vramMB = (id: string) => VRAM_MB[id] ?? 0;


export const MODELS: ModelChoice[] = [
  { key: "qwen-1.5b", label: "Qwen2.5 1.5B", f16: "Qwen2.5-1.5B-Instruct-q4f16_1-MLC", f32: "Qwen2.5-1.5B-Instruct-q4f32_1-MLC", blurb: "the default: the best balance of size and sense" },
  { key: "qwen-3b", label: "Qwen2.5 3B", f16: "Qwen2.5-3B-Instruct-q4f16_1-MLC", f32: "Qwen2.5-3B-Instruct-q4f32_1-MLC", blurb: "better notes, slower, a bigger download" },
  { key: "llama-1b", label: "Llama 3.2 1B", f16: "Llama-3.2-1B-Instruct-q4f16_1-MLC", f32: "Llama-3.2-1B-Instruct-q4f32_1-MLC", blurb: "the smallest and fastest, and it shows" },
];


export interface GpuCheck {
  ok: boolean;
  f16: boolean;
  reason?: string;
}

export async function checkWebGPU(): Promise<GpuCheck> {
  const gpu = (navigator as any).gpu;
  if (!gpu) return { ok: false, f16: false, reason: "This browser doesn't have WebGPU. Recent Chrome, Edge or Safari 26 on a desktop or laptop do." };
  try {
    const adapter = await gpu.requestAdapter();
    if (!adapter) return { ok: false, f16: false, reason: "WebGPU is here, but no GPU adapter is available." };
    return { ok: true, f16: adapter.features.has("shader-f16") };
  } catch (err) {
    return { ok: false, f16: false, reason: `WebGPU failed to start: ${(err as Error).message}` };
  }
}

