import type { ProviderSettings } from "@reader/core";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { createLlmClient } from "../src/index.js";
import { collect, sampleParts, stable, streamOf } from "./helpers.js";

const settings: ProviderSettings = {
  kind: "test",
  aliases: { fast: { model: "m-fast", reasoning: "none" }, smart: { model: "m-smart", reasoning: "high" }, vision: null, image: null },
  capabilities: {},
};

describe("流式映射（MockLanguageModelV4）", () => {
  it("思考、文本、结束 → LlmChunk 序列和用量；reasoning 透传给模型", async () => {
    const model = new MockLanguageModelV4({ modelId: "m-smart", doStream: async () => streamOf(sampleParts()) });
    const client = createLlmClient({ providerId: "test", settings, languageModel: () => model, recordings: { mode: "off" } });
    const ac = new AbortController();
    const chunks = await collect(client.stream({ runId: "r1", alias: "smart", instructions: "简短", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }, ac.signal));
    expect(stable(chunks)).toEqual([
      { type: "start", runId: "r1", providerId: "test", alias: "smart", modelId: "m-smart", notes: [] },
      { type: "reasoning", delta: "想一想" },
      { type: "text", delta: "你好" },
      { type: "text", delta: "，世界" },
      { type: "finish", finishReason: "stop", usage: { inputTokens: 12, outputTokens: 7, reasoningTokens: 3 } },
    ]);
    const fin = chunks.at(-1) as Extract<(typeof chunks)[number], { type: "finish" }>;
    expect(fin.firstChunkMs).toBeGreaterThanOrEqual(0);
    expect(model.doStreamCalls[0]?.reasoning).toBe("high");
    expect(model.doStreamCalls[0]?.prompt[0]).toMatchObject({ role: "system", content: "简短" });
    expect(structuredClone(chunks)).toEqual(chunks);
  });

  it("模型抛错 → error 分块（不抛异常）", async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => {
        throw Object.assign(new Error("bad key"), { name: "GatewayAuthenticationError", statusCode: 401 });
      },
    });
    const client = createLlmClient({ providerId: "test", settings, languageModel: () => model, recordings: { mode: "off" } });
    const chunks = await collect(client.stream({ runId: "r2", alias: "fast", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }, new AbortController().signal));
    expect(chunks.map((c) => c.type)).toEqual(["start", "error"]);
    expect(chunks[1]).toMatchObject({ error: { code: "unauthorized" } });
  });

  it("已取消的 signal → aborted", async () => {
    const model = new MockLanguageModelV4({ doStream: async () => streamOf(sampleParts()) });
    const client = createLlmClient({ providerId: "test", settings, languageModel: () => model, recordings: { mode: "off" } });
    const ac = new AbortController();
    ac.abort();
    const chunks = await collect(client.stream({ runId: "r3", alias: "fast", messages: [] }, ac.signal));
    expect(chunks.at(-1)).toMatchObject({ type: "error", error: { code: "aborted" } });
  });

  it("能力检查失败时不调用模型", async () => {
    const model = new MockLanguageModelV4({ doStream: async () => streamOf(sampleParts()) });
    const client = createLlmClient({ providerId: "test", settings, languageModel: () => model, recordings: { mode: "off" } });
    const chunks = await collect(client.stream({ runId: "r4", alias: "image", messages: [] }, new AbortController().signal));
    expect(chunks).toMatchObject([{ type: "error", error: { code: "capability_missing" } }]);
    expect(model.doStreamCalls).toHaveLength(0);
  });
});
