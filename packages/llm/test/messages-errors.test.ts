import { describe, expect, it } from "vitest";
import { toLlmErrorInfo, toModelMessages } from "../src/index.js";

describe("toModelMessages", () => {
  it("文本和图片片段映射成 ModelMessage", () => {
    expect(
      toModelMessages([
        { role: "user", content: [{ type: "text", text: "看图" }, { type: "image", mediaType: "image/png", dataBase64: "QUJD", alt: "x" }] },
        { role: "assistant", content: [{ type: "text", text: "好" }, { type: "image", mediaType: "image/png", dataBase64: "QUJD", alt: "旧图" }] },
      ]),
    ).toEqual([
      { role: "user", content: [{ type: "text", text: "看图" }, { type: "image", image: "QUJD", mediaType: "image/png" }] },
      { role: "assistant", content: [{ type: "text", text: "好" }, { type: "text", text: "[图：旧图]" }] },
    ]);
  });
});

describe("toLlmErrorInfo", () => {
  const err = (o: Record<string, unknown>) => Object.assign(new Error(String(o.message ?? "x")), o);
  const cases: Array<[string, unknown, string]> = [
    ["网关 401", err({ name: "GatewayAuthenticationError", statusCode: 401 }), "unauthorized"],
    ["OpenAI 兼容 401", err({ name: "AI_APICallError", statusCode: 401 }), "unauthorized"],
    ["403 受限模型", err({ name: "GatewayForbiddenError", statusCode: 403, message: "RestrictedModelsError" }), "restricted_model"],
    ["正文里的 no_providers_available", err({ name: "GatewayResponseError", responseBody: '{"error":{"type":"no_providers_available"}}' }), "restricted_model"],
    ["模型不存在", err({ name: "GatewayModelNotFoundError", statusCode: 404, modelId: "deepseek/x" }), "model_not_found"],
    ["429", err({ name: "GatewayRateLimitError", statusCode: 429 }), "rate_limited"],
    ["重试耗尽包一层", err({ name: "AI_RetryError", lastError: err({ name: "AI_APICallError", statusCode: 429 }) }), "rate_limited"],
    ["断网", new TypeError("fetch failed"), "network"],
    ["取消", Object.assign(new Error("The operation was aborted"), { name: "AbortError" }), "aborted"],
    ["bridge 没有密钥", err({ name: "AI_APICallError", statusCode: 401, responseBody: '{"error":{"code":"no_key"}}' }), "no_key"],
    ["生产构建没有 bridge（transport 换成的响应）", err({ name: "AI_APICallError", statusCode: 404, responseBody: '{"error":{"code":"no_bridge"}}' }), "no_bridge"],
    ["上游 404（地址或接口不对）", err({ name: "AI_APICallError", statusCode: 404, responseBody: "404 page not found" }), "provider_error"],
    ["回放未命中", err({ name: "ReplayMissError", message: "没有录制" }), "replay_miss"],
    ["5xx", err({ name: "AI_APICallError", statusCode: 502 }), "provider_error"],
  ];
  for (const [label, e, code] of cases) {
    it(label, () => {
      const info = toLlmErrorInfo(e);
      expect(info.code).toBe(code);
      expect(structuredClone(info)).toEqual(info);
    });
  }
  it("429 和 5xx 可重试，401 不可", () => {
    expect(toLlmErrorInfo(err({ statusCode: 429 })).retryable).toBe(true);
    expect(toLlmErrorInfo(err({ statusCode: 503 })).retryable).toBe(true);
    expect(toLlmErrorInfo(err({ statusCode: 401 })).retryable).toBe(false);
  });
});
