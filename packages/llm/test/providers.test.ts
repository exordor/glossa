import { type LlmChunk, MemorySettingsStore, Registry, createAppLlm, defaultSettings } from "@reader/core";
import { describe, expect, it } from "vitest";
import {
  BRIDGE_HEADER,
  bridgePath,
  createBridgeTransport,
  directTransport,
  networkGuardTransport,
  registerBuiltinLlmProviders,
} from "../src/index.js";
import { collect } from "./helpers.js";

const ORIGIN = "http://localhost:5173";

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

/** 假 fetch：记录请求，按路径回答。 */
function fakeFetch(routes: Record<string, () => Response>) {
  const seen: Seen[] = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    seen.push({ url, method: init?.method ?? "GET", headers, body: typeof init?.body === "string" ? init.body : null });
    const path = new URL(url).pathname;
    const route = Object.keys(routes).find((p) => path === p || path.startsWith(p));
    return route ? routes[route]!() : new Response("Not Found", { status: 404 });
  };
  return { fetch, seen };
}

const sse = (events: unknown[]) =>
  new Response(events.map((e) => `data: ${typeof e === "string" ? e : JSON.stringify(e)}\n\n`).join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });

const chatChunks = (model: string) => [
  { id: "c1", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: { role: "assistant", content: "你好" }, finish_reason: null }] },
  { id: "c1", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: { content: "！" }, finish_reason: "stop" }] },
  { id: "c1", object: "chat.completion.chunk", created: 1, model, choices: [], usage: { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 } },
  "[DONE]",
];

function setup(fetch: ReturnType<typeof fakeFetch>["fetch"], active: string, providers: Record<string, unknown> = {}) {
  const s = defaultSettings();
  s.llm.activeProvider = active;
  s.llm.providers = providers as typeof s.llm.providers;
  const app = createAppLlm({ settings: new MemorySettingsStore(s) });
  registerBuiltinLlmProviders(app.registry, { transport: createBridgeTransport({ origin: ORIGIN, fetch }), recordings: { mode: "off" } });
  return app;
}

const textOf = (chunks: LlmChunk[]) => chunks.flatMap((c) => (c.type === "text" ? [c.delta] : [])).join("");

describe("bridge 地址约定", () => {
  it("上游地址改写到 /__llm/<providerId>，保留查询串；别的上游拒绝", () => {
    expect(bridgePath("vercel-gateway", "https://ai-gateway.vercel.sh", "https://ai-gateway.vercel.sh/v1/generation?id=gen_1")).toBe(
      "/__llm/vercel-gateway/v1/generation?id=gen_1",
    );
    expect(bridgePath("openai-compatible", "http://localhost:11434/v1/", "http://localhost:11434/v1/models")).toBe("/__llm/openai-compatible/models");
    expect(() => bridgePath("deepseek", "https://api.deepseek.com", "https://evil.example/chat")).toThrow();
    expect(() => bridgePath("deepseek", "https://api.deepseek.com", "https://api.deepseek.com.evil.example/x")).toThrow();
  });
});

describe("内置 provider 经 bridge 传输", () => {
  it("注册三个内置 provider（owner builtin）", () => {
    const r = new Registry();
    registerBuiltinLlmProviders(r, { transport: networkGuardTransport() });
    expect(r.list("llmProvider").map((p) => p.id)).toEqual(["vercel-gateway", "deepseek", "openai-compatible"]);
    expect(r.ownerOf("llmProvider", "deepseek")).toBe("builtin");
  });

  it("vercel-gateway：语言模型请求、/v1/credits、/v1/models 都改写到同源 bridge，带 x-glossa-bridge，不带 authorization", async () => {
    const f = fakeFetch({
      "/__llm/vercel-gateway/v1/credits": () => Response.json({ balance: "12.50", total_used: "3.25" }),
      "/__llm/vercel-gateway/v1/models": () => Response.json({ data: [{ id: "deepseek/deepseek-v4.1-flash-1017", type: "language", context_window: 1048576 }] }),
      "/__llm/vercel-gateway/v4/ai/": () => Response.json({ error: { message: "bad request", type: "invalid_request_error" } }, { status: 400 }),
    });
    const { llm } = setup(f.fetch, "vercel-gateway");
    const chunks = await collect(llm.test("fast"));
    expect(chunks[0]).toMatchObject({ type: "start", modelId: "deepseek/deepseek-v4.1-flash-1017" });
    expect(chunks.at(-1)?.type).toBe("error");
    expect(await llm.credits()).toEqual({ balance: "12.50", totalUsed: "3.25", currency: "USD" });
    const models = await llm.listModels();
    expect(Array.isArray(models) && models[0]?.contextWindow).toBe(1048576);

    expect(f.seen.length).toBeGreaterThanOrEqual(3);
    for (const s of f.seen) {
      expect(s.url.startsWith(`${ORIGIN}/__llm/vercel-gateway/`)).toBe(true);
      expect(s.headers[BRIDGE_HEADER]).toBe("1");
      expect(s.headers.authorization).toBeUndefined();
    }
    const paths = f.seen.map((s) => new URL(s.url).pathname);
    expect(paths.some((p) => p.startsWith("/__llm/vercel-gateway/v4/ai/"))).toBe(true);
    expect(paths).toContain("/__llm/vercel-gateway/v1/credits");
    expect(paths).toContain("/__llm/vercel-gateway/v1/models");
  });

  it("deepseek：POST /__llm/deepseek/chat/completions，SSE 流式映射成分块", async () => {
    const f = fakeFetch({ "/__llm/deepseek/chat/completions": () => sse(chatChunks("deepseek-chat")) });
    const { llm } = setup(f.fetch, "deepseek");
    const chunks = await collect(llm.run({ alias: "fast", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }));
    expect(chunks[0]).toMatchObject({ type: "start", providerId: "deepseek", modelId: "deepseek-chat" });
    expect(textOf(chunks)).toBe("你好！");
    expect(chunks.at(-1)).toMatchObject({ type: "finish", finishReason: "stop", usage: { inputTokens: 9, outputTokens: 2 } });
    expect(f.seen[0]?.method).toBe("POST");
    expect(new URL(f.seen[0]!.url).pathname).toBe("/__llm/deepseek/chat/completions");
    expect(JSON.parse(f.seen[0]!.body!)).toMatchObject({ model: "deepseek-chat", stream: true });
    expect(f.seen[0]?.headers.authorization).toBeUndefined();
  });

  it("deepseek：没有 vision 模型时图片退化为图注", async () => {
    const f = fakeFetch({ "/__llm/deepseek/chat/completions": () => sse(chatChunks("deepseek-chat")) });
    const { llm } = setup(f.fetch, "deepseek");
    const chunks = await collect(
      llm.run({ alias: "smart", messages: [{ role: "user", content: [{ type: "image", mediaType: "image/png", dataBase64: "AAAA", alt: "图 2" }] }] }),
    );
    expect(chunks[0]).toMatchObject({ type: "start", modelId: "deepseek-reasoner", notes: ["模型不支持图像，已用图注代替"] });
    expect(f.seen[0]!.body).toContain("[图：图 2]");
  });

  it("openai-compatible：baseURL 来自设置；模型列表走 /__llm/openai-compatible/models", async () => {
    const f = fakeFetch({
      "/__llm/openai-compatible/chat/completions": () => sse(chatChunks("llama3.2")),
      "/__llm/openai-compatible/models": () => Response.json({ object: "list", data: [{ id: "llama3.2", object: "model" }] }),
    });
    const { llm } = setup(f.fetch, "openai-compatible", {
      "openai-compatible": { baseURL: "http://localhost:11434/v1", aliases: { fast: { model: "llama3.2" } } },
    });
    const chunks = await collect(llm.test("fast"));
    expect(textOf(chunks)).toBe("你好！");
    expect(await llm.listModels()).toMatchObject([{ modelId: "llama3.2", source: "remote" }]);
    expect(f.seen.map((s) => new URL(s.url).pathname)).toEqual(["/__llm/openai-compatible/chat/completions", "/__llm/openai-compatible/models"]);
    // 未配置的别名不发请求。
    const smart = await collect(llm.test("smart"));
    expect(smart).toMatchObject([{ type: "error", error: { code: "capability_missing" } }]);
  });

  it("没有 bridge（生产构建 404）→ no_bridge", async () => {
    const f = fakeFetch({});
    const { llm } = setup(f.fetch, "deepseek");
    const chunks = await collect(llm.test("fast"));
    expect(chunks.at(-1)).toMatchObject({ type: "error", error: { code: "no_bridge" } });
  });

  it("bridge 没有密钥（401 no_key）→ no_key", async () => {
    const f = fakeFetch({ "/__llm/deepseek/": () => Response.json({ error: { code: "no_key", message: "未配置密钥" } }, { status: 401 }) });
    const { llm } = setup(f.fetch, "deepseek");
    const chunks = await collect(llm.test("fast"));
    expect(chunks.at(-1)).toMatchObject({ type: "error", error: { code: "no_key" } });
  });

  it("网关 + bridge 没有密钥（401 no_key）→ no_key（网关错误类把原始响应放在 cause 里）", async () => {
    const f = fakeFetch({
      "/__llm/vercel-gateway/": () => Response.json({ error: { code: "no_key", type: "no_key", message: "未配置密钥" } }, { status: 401 }),
    });
    const { llm } = setup(f.fetch, "vercel-gateway");
    const chunks = await collect(llm.test("fast"));
    expect(chunks.at(-1)).toMatchObject({ type: "error", error: { code: "no_key", message: "还没有配置 API 密钥" } });
  });

  it("网关 + 没有 bridge（404 HTML）→ no_bridge", async () => {
    const f = fakeFetch({});
    const { llm } = setup(f.fetch, "vercel-gateway");
    const chunks = await collect(llm.test("fast"));
    expect(chunks.at(-1)).toMatchObject({ type: "error", error: { code: "no_bridge" } });
  });

  it("directTransport：密钥由调用方提供，直连上游", async () => {
    const f = fakeFetch({ "/chat/completions": () => sse(chatChunks("deepseek-chat")) });
    const s = defaultSettings();
    s.llm.activeProvider = "deepseek";
    const app = createAppLlm({ settings: new MemorySettingsStore(s) });
    registerBuiltinLlmProviders(app.registry, {
      transport: directTransport({ fetch: f.fetch, apiKey: (id) => (id === "deepseek" ? "sk-test" : undefined) }),
      recordings: { mode: "off" },
    });
    await collect(app.llm.test("fast"));
    expect(f.seen[0]?.url).toBe("https://api.deepseek.com/chat/completions");
    expect(f.seen[0]?.headers.authorization).toBe("Bearer sk-test");
  });

  it("vitest 默认 replay：没有录制存储时 replay_miss，且不发任何请求", async () => {
    const f = fakeFetch({});
    const s = defaultSettings();
    const app = createAppLlm({ settings: new MemorySettingsStore(s) });
    registerBuiltinLlmProviders(app.registry, { transport: createBridgeTransport({ origin: ORIGIN, fetch: f.fetch }) });
    const chunks = await collect(app.llm.test("fast"));
    expect(chunks.at(-1)).toMatchObject({ type: "error", error: { code: "replay_miss" } });
    expect(f.seen).toEqual([]);
  });
});
