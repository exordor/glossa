import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fromGatewayModel, fromOpenAiModel, modelListEntries, DEEPSEEK_CAPABILITIES } from "../src/index.js";

const sample = JSON.parse(readFileSync(new URL("./fixtures/gateway-models-sample.json", import.meta.url), "utf8"));
const NOW = "2026-11-08T00:00:00.000Z";

describe("能力表映射", () => {
  it("网关 /v1/models 样例 → ModelCapability", () => {
    const caps = modelListEntries(sample).map((e) => fromGatewayModel(e, NOW));
    expect(caps[0]).toEqual({
      modelId: "deepseek/deepseek-v4.1-flash-1017",
      label: "DeepSeek V4.1 Flash 1017",
      input: { text: true, image: true, pdf: true },
      output: { text: true, image: false },
      contextWindow: 1048576,
      maxOutputTokens: 262144,
      reasoningLevels: ["none", "low", "high", "max"],
      structuredOutput: true,
      toolUse: true,
      pricing: { inputPerMTok: 0.3, outputPerMTok: 1.2, cachedInputPerMTok: 0.03 },
      source: "remote",
      fetchedAt: NOW,
    });
    expect(caps[1]).toMatchObject({ input: { image: false }, pricing: null, structuredOutput: null });
    expect(caps[2]).toBeNull();
  });

  it("OpenAI 兼容 /models 只有 id：用内置种子补全，否则保守填", () => {
    const list = modelListEntries({ data: [{ id: "deepseek-chat", object: "model" }, { id: "llama3.2" }] });
    expect(fromOpenAiModel(list[0], DEEPSEEK_CAPABILITIES["deepseek-chat"], NOW)).toMatchObject({ contextWindow: 131072, source: "remote" });
    expect(fromOpenAiModel(list[1], undefined, NOW)).toMatchObject({ modelId: "llama3.2", input: { image: false }, contextWindow: 0 });
  });
});
