import { describe, expect, it } from "vitest";
import {
  EVENT_NAMES,
  type GlobalSettings,
  type LlmChunk,
  type LlmProviderContribution,
  MemorySettingsStore,
  Reader,
  type ReaderEvents,
  createAppLlm,
  defaultSettings,
  testRequest,
} from "../src/index.js";

/** 不依赖 AI SDK 的假 provider：逐字吐出 reply；hang 为 true 时一直等到被取消。 */
function fakeProvider(opts: { reply?: string; fail?: boolean; hang?: boolean } = {}): LlmProviderContribution {
  return {
    id: "fake",
    name: "Fake",
    requiresKey: false,
    defaults: () => ({ kind: "fake", aliases: { fast: { model: "fake-1" }, smart: { model: "fake-2" }, vision: null, image: null } }),
    async create(settings) {
      return {
        async *stream(req, signal) {
          const binding = settings.aliases[req.alias];
          if (!binding) {
            yield { type: "error", error: { code: "capability_missing", message: "无", retryable: false } };
            return;
          }
          yield { type: "start", runId: req.runId, providerId: "fake", alias: req.alias, modelId: binding.model, notes: [] };
          if (opts.hang) {
            await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
            yield { type: "error", error: { code: "aborted", message: "已取消", retryable: false } };
            return;
          }
          if (opts.fail) {
            yield { type: "error", error: { code: "unauthorized", message: "密钥无效或已撤销", retryable: false, status: 401 } };
            return;
          }
          for (const ch of opts.reply ?? "你好") yield { type: "text", delta: ch };
          yield { type: "finish", finishReason: "stop", usage: { inputTokens: 3, outputTokens: 2 }, durationMs: 1 };
        },
        async listModels() {
          return [];
        },
        async credits() {
          return null;
        },
      };
    },
  };
}

function setup(provider: LlmProviderContribution) {
  const initial = defaultSettings();
  initial.llm.activeProvider = "fake";
  const store = new MemorySettingsStore(initial);
  const app = createAppLlm({ settings: store });
  app.registry.register("llmProvider", provider);
  const log: Array<{ name: string; payload: unknown }> = [];
  for (const name of EVENT_NAMES) {
    app.events.on(name, (p: ReaderEvents[typeof name]) => log.push({ name, payload: p }));
  }
  return { ...app, store, log };
}

async function collect(it: AsyncIterable<LlmChunk>): Promise<LlmChunk[]> {
  const out: LlmChunk[] = [];
  for await (const c of it) out.push(c);
  return out;
}

describe("LlmService", () => {
  it("run.started → 分块 → run.completed{ok:true}", async () => {
    const { llm, log } = setup(fakeProvider({ reply: "好的" }));
    const chunks = await collect(llm.run({ alias: "fast", nodeId: "n1", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }));
    expect(chunks.map((c) => c.type)).toEqual(["start", "text", "text", "finish"]);
    const runId = (chunks[0] as Extract<LlmChunk, { type: "start" }>).runId;
    expect(log).toEqual([
      { name: "run.started", payload: { runId, nodeId: "n1", providerId: "fake", alias: "fast", modelId: "fake-1" } },
      { name: "run.completed", payload: { runId, nodeId: "n1", ok: true } },
    ]);
    // 分块和事件负载都可结构化克隆（可跨 Worker / iframe）。
    expect(structuredClone(chunks)).toEqual(chunks);
    expect(structuredClone(log)).toEqual(log);
  });

  it("出错时 run.completed{ok:false}，不抛异常", async () => {
    const { llm, log } = setup(fakeProvider({ fail: true }));
    const chunks = await collect(llm.run({ alias: "fast", messages: [] }));
    expect(chunks.at(-1)).toMatchObject({ type: "error", error: { code: "unauthorized" } });
    expect(log.at(-1)).toMatchObject({ name: "run.completed", payload: { ok: false, nodeId: "" } });
  });

  it("能力检查失败：没有 run.started，但仍有 run.completed{ok:false}", async () => {
    const { llm, log } = setup(fakeProvider());
    const chunks = await collect(llm.run({ alias: "image", messages: [] }));
    expect(chunks).toEqual([{ type: "error", error: { code: "capability_missing", message: "无", retryable: false } }]);
    expect(log.map((e) => e.name)).toEqual(["run.completed"]);
  });

  it("cancel(runId) 产生 aborted 分块", async () => {
    const { llm, log } = setup(fakeProvider({ hang: true }));
    const it = llm.run({ alias: "fast", runId: "R1", messages: [] });
    const chunks: LlmChunk[] = [];
    for await (const c of it) {
      chunks.push(c);
      if (c.type === "start") await llm.cancel("R1");
    }
    expect(chunks.at(-1)).toMatchObject({ type: "error", error: { code: "aborted" } });
    expect(log.at(-1)).toEqual({ name: "run.completed", payload: { runId: "R1", nodeId: "", ok: false } });
  });

  it("没有注册当前 provider 时返回 no_provider", async () => {
    const app = createAppLlm();
    const chunks = await collect(app.llm.run({ alias: "fast", messages: [] }));
    expect(chunks).toMatchObject([{ type: "error", error: { code: "no_provider" } }]);
  });

  it("test() 用固定提示词且不发 run.* 事件", async () => {
    const { llm, log } = setup(fakeProvider());
    const chunks = await collect(llm.test("fast"));
    expect(chunks.at(-1)?.type).toBe("finish");
    expect(log).toEqual([]);
    expect(testRequest("vision").messages[0]?.content[0]?.type).toBe("image");
    expect(testRequest("fast").maxOutputTokens).toBe(120);
  });

  it("saveSettings 发 settings.changed（只含变化路径），并合并 provider 默认值", async () => {
    const { llm, log, store } = setup(fakeProvider());
    const s: GlobalSettings = await llm.getSettings();
    s.llm.providers.fake = { aliases: { fast: { model: "fake-9", reasoning: "low" } } };
    s.onboarding = { status: "done", updatedAt: "2026-11-08T00:00:00.000Z" };
    expect(await llm.saveSettings(s)).toEqual(["llm.providers", "onboarding.status", "onboarding.updatedAt"]);
    expect(log).toEqual([{ name: "settings.changed", payload: { keys: ["llm.providers", "onboarding.status", "onboarding.updatedAt"] } }]);
    expect(await llm.saveSettings(s)).toEqual([]);
    expect(store.snapshot()).toContain("fake-9");
    const eff = await llm.providerSettings();
    expect(eff?.aliases.fast).toEqual({ model: "fake-9", reasoning: "low" });
    expect(eff?.aliases.smart).toEqual({ model: "fake-2" });
    const providers = await llm.listProviders();
    expect(providers).toEqual([{ id: "fake", name: "Fake", requiresKey: false, active: true }]);
  });

  it("reloadSettings 从存储重读，有变化时发事件", async () => {
    const { llm, log, store } = setup(fakeProvider());
    await llm.getSettings();
    const s = await store.load();
    s.llm.budget.contextTokens = 5000;
    await store.save(s);
    const next = await llm.reloadSettings();
    expect(next.llm.budget.contextTokens).toBe(5000);
    expect(log).toEqual([{ name: "settings.changed", payload: { keys: ["llm.budget"] } }]);
  });

  it("Reader 带 llm，并与 reader.registry / events 共用", async () => {
    const vault = { readText: async () => null, writeText: async () => {}, list: async () => [], readBytes: async () => null, remove: async () => {} };
    const initial = defaultSettings();
    initial.llm.activeProvider = "fake";
    const reader = new Reader(vault, { settings: new MemorySettingsStore(initial) });
    reader.registry.register("llmProvider", fakeProvider());
    const seen: string[] = [];
    reader.events.on("run.started", (p) => seen.push(p.modelId));
    await collect(reader.llm.run({ alias: "smart", messages: [] }));
    expect(seen).toEqual(["fake-2"]);
    expect(reader.apiVersion).toBe("0.2.0");
  });
});
