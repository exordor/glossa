import type { LlmChunk } from "@reader/core";
import { convertArrayToReadableStream } from "ai/test";

export async function collect(it: AsyncIterable<LlmChunk>): Promise<LlmChunk[]> {
  const out: LlmChunk[] = [];
  for await (const c of it) out.push(c);
  return out;
}

/** 去掉随时间变化的字段，便于比较。 */
export const stable = (chunks: LlmChunk[]) =>
  chunks.map((c) => {
    if (c.type !== "finish") return c;
    const { durationMs: _d, firstChunkMs: _f, ...rest } = c;
    return rest;
  });

export const usageV4 = (input: number, output: number, reasoning?: number) => ({
  inputTokens: { total: input, noCache: input, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: output, text: reasoning === undefined ? output : output - reasoning, reasoning },
});

/** 一段典型的 V4 流：思考 → 文本 → 结束。 */
export function sampleParts(text = ["你好", "，世界"]) {
  return [
    { type: "stream-start" as const, warnings: [] },
    { type: "response-metadata" as const, id: "resp-1", modelId: "m", timestamp: new Date("2026-11-08T00:00:00Z") },
    { type: "reasoning-start" as const, id: "r0" },
    { type: "reasoning-delta" as const, id: "r0", delta: "想一想" },
    { type: "reasoning-end" as const, id: "r0" },
    { type: "text-start" as const, id: "t0" },
    ...text.map((delta) => ({ type: "text-delta" as const, id: "t0", delta })),
    { type: "text-end" as const, id: "t0" },
    { type: "finish" as const, finishReason: { unified: "stop" as const, raw: "stop" }, usage: usageV4(12, 7, 3) },
  ];
}

export const streamOf = (parts: unknown[]) => ({ stream: convertArrayToReadableStream(parts as never[]) });
