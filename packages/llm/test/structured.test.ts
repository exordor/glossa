import type { LlmChunk, ProviderSettings } from "@reader/core";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { createLlmClient } from "../src/index.js";
import { collect, sampleParts, streamOf } from "./helpers.js";

const settings: ProviderSettings = {
  kind: "test",
  aliases: { fast: { model: "m-fast", reasoning: "none" }, smart: null, vision: null, image: null },
  capabilities: {},
};
const schema = {
  type: "object",
  properties: { summary: { type: "string" }, points: { type: "array", items: { type: "string" } } },
  required: ["summary", "points"],
  additionalProperties: false,
};
const hi = [{ role: "user" as const, content: [{ type: "text" as const, text: "hi" }] }];

async function run(text: string[]) {
  const model = new MockLanguageModelV4({ modelId: "m-fast", doStream: async () => streamOf(sampleParts(text)) });
  const client = createLlmClient({ providerId: "test", settings, languageModel: () => model, recordings: { mode: "off" } });
  const chunks = await collect(client.stream({ runId: "r", alias: "fast", messages: hi, output: { type: "json", schema, name: "answer" } }, new AbortController().signal));
  return { model, chunks, objects: chunks.filter((c): c is Extract<LlmChunk, { type: "object" }> => c.type === "object") };
}

describe("结构化输出", () => {
  it("response_format 带 schema 传给模型；流式给出半截对象，结束时给出完整对象", async () => {
    const { model, chunks, objects } = await run(['{"summary":"注意', '力是映射","points":["查询', '","键值"]}']);
    expect(model.doStreamCalls[0]?.responseFormat).toMatchObject({ type: "json", schema, name: "answer" });
    expect(objects[0]).toEqual({ type: "object", value: { summary: "注意" }, final: false });
    expect(objects.at(-1)).toEqual({ type: "object", value: { summary: "注意力是映射", points: ["查询", "键值"] }, final: true });
    // 文本增量照常送出（录制、调试用），结束块在完整对象之后
    expect(chunks.filter((c) => c.type === "text").length).toBe(3);
    expect(chunks.at(-1)?.type).toBe("finish");
  });

  it("去掉 ```json 围栏", async () => {
    const { objects } = await run(['```json\n{"summary":"a","points":[]}\n```']);
    expect(objects.at(-1)).toEqual({ type: "object", value: { summary: "a", points: [] }, final: true });
  });

  it("模型没给 JSON：没有 final 块，流照常结束（调用方退回按文字处理）", async () => {
    const { chunks, objects } = await run(["注意力是映射。\n- 查询"]);
    expect(objects.filter((o) => o.final)).toEqual([]);
    expect(chunks.at(-1)?.type).toBe("finish");
  });
});
