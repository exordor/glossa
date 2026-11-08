import type { LlmRequest, ProviderSettings } from "@reader/core";
import { describe, expect, it } from "vitest";
import { GATEWAY_CAPABILITIES, GATEWAY_FLASH, GATEWAY_PRO, planCall } from "../src/index.js";

const img = { type: "image" as const, mediaType: "image/png", dataBase64: "AAAA", alt: "图 1：注意力热图" };
const settings = (over: Partial<ProviderSettings["aliases"]> = {}): ProviderSettings => ({
  kind: "vercel-gateway",
  aliases: {
    fast: { model: GATEWAY_FLASH, reasoning: "none" },
    smart: { model: GATEWAY_PRO, reasoning: "high" },
    vision: { model: GATEWAY_FLASH, reasoning: "low" },
    image: null,
    ...over,
  },
  capabilities: structuredClone(GATEWAY_CAPABILITIES),
});
const req = (r: Partial<LlmRequest>): LlmRequest => ({ alias: "smart", messages: [], ...r });

describe("planCall 能力检查", () => {
  it("smart（Pro 只支持文本）带图片 → 改用 vision 并注明", () => {
    const p = planCall(req({ messages: [{ role: "user", content: [img, { type: "text", text: "这是什么" }] }] }), settings());
    expect(p).toMatchObject({ alias: "vision", modelId: GATEWAY_FLASH, binding: { reasoning: "low" } });
    expect("notes" in p && p.notes).toEqual([`模型不支持图像，已改用 vision（${GATEWAY_FLASH}）`]);
    expect("messages" in p && p.messages[0]?.content[0]).toEqual(img);
  });

  it("没有能看图的 vision → 图片换成图注", () => {
    const p = planCall(req({ messages: [{ role: "user", content: [img, { type: "image", mediaType: "image/png", dataBase64: "B" }] }] }), settings({ vision: null }));
    expect("messages" in p && p.messages[0]?.content).toEqual([
      { type: "text", text: "[图：图 1：注意力热图]" },
      { type: "text", text: "[图：无图注]" },
    ]);
    expect("notes" in p && p.notes).toEqual(["模型不支持图像，已用图注代替"]);
  });

  it("支持图像的模型直接用，不改别名", () => {
    const p = planCall(req({ alias: "fast", messages: [{ role: "user", content: [img] }] }), settings());
    expect(p).toMatchObject({ alias: "fast", modelId: GATEWAY_FLASH, notes: [] });
  });

  it("image 别名 → capability_missing", () => {
    expect(planCall(req({ alias: "image" }), settings())).toEqual({
      code: "capability_missing",
      message: "当前模型不支持生成图片（DeepSeek 没有图像生成模型）",
      retryable: false,
    });
  });

  it("未配置的别名 → capability_missing", () => {
    expect(planCall(req({ alias: "fast" }), settings({ fast: null }))).toMatchObject({ code: "capability_missing" });
  });

  it("超出上下文长度 → 错误", () => {
    const s = settings();
    s.capabilities![GATEWAY_PRO]!.contextWindow = 10;
    expect(planCall(req({ messages: [{ role: "user", content: [{ type: "text", text: "一".repeat(30) }] }] }), s)).toMatchObject({
      code: "capability_missing",
      message: "内容超出模型上下文长度",
    });
  });

  it("要求 JSON 而模型不支持结构化输出 → 注明", () => {
    const s = settings();
    s.capabilities![GATEWAY_PRO]!.structuredOutput = false;
    const p = planCall(req({ output: { type: "json", schema: {} } }), s);
    expect("notes" in p && p.notes).toEqual(["模型不支持结构化输出，改用提示词约束 JSON"]);
  });
});
