/**
 * LlmService：界面、CLI、MCP 调 LLM 的唯一入口（reader.llm）。
 * 从注册表的 llmProvider 里找当前 provider，合并设置，执行流式调用并发事件。
 * 不依赖 AI SDK；SDK 只在 @reader/llm 的 provider 实现里。
 */
import { EventBus } from "./events.js";
import { newId } from "./ids.js";
import type {
  AliasMap,
  LlmChunk,
  LlmClient,
  LlmCredits,
  LlmErrorInfo,
  LlmMessage,
  LlmProviderContribution,
  LlmRequest,
  ModelCapability,
  ProviderSettings,
} from "./llm.js";
import { isLlmError } from "./llm.js";
import { type ModelAlias, Registry } from "./registry.js";
import {
  type GlobalSettings,
  MemorySettingsStore,
  type SettingsStore,
  type StoredProviderSettings,
  changedSettingsKeys,
  normalizeSettings,
} from "./settings.js";
import { stableStringify } from "./stable-json.js";

/** 设置页列 provider 用。 */
export interface LlmProviderInfo {
  id: string;
  name: string;
  keyEnvVar?: string;
  requiresKey: boolean;
  docsUrl?: string;
  active: boolean;
}

/** 一键测试的固定提示词（设计文档 §7）。vision 附一张 1×1 红色 PNG。 */
export const LLM_TEST_INSTRUCTIONS = "用一句中文回答。";
export const LLM_TEST_PROMPT = "请用一句话介绍你自己，并说出你的模型名称。";
export const LLM_TEST_VISION_PROMPT = "这张图是什么颜色？";
export const LLM_TEST_IMAGE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

export function testRequest(alias: ModelAlias): LlmRequest {
  const messages: LlmMessage[] =
    alias === "vision"
      ? [
          {
            role: "user",
            content: [
              { type: "image", mediaType: "image/png", dataBase64: LLM_TEST_IMAGE_PNG_BASE64, alt: "一个红色像素" },
              { type: "text", text: LLM_TEST_VISION_PROMPT },
            ],
          },
        ]
      : [{ role: "user", content: [{ type: "text", text: LLM_TEST_PROMPT }] }];
  return { alias, instructions: LLM_TEST_INSTRUCTIONS, messages, maxOutputTokens: 120 };
}

/** 合并 provider 默认设置与用户存的覆盖项。别名逐个覆盖（null 表示用户显式关掉）。 */
export function mergeProviderSettings(defaults: ProviderSettings, stored: StoredProviderSettings | undefined): ProviderSettings {
  if (!stored) return structuredClone(defaults);
  const aliases = { ...defaults.aliases } as AliasMap;
  for (const [k, v] of Object.entries(stored.aliases ?? {})) if (v !== undefined) aliases[k as ModelAlias] = v;
  const capabilities = { ...(defaults.capabilities ?? {}), ...(stored.capabilities ?? {}) };
  return structuredClone({ ...defaults, ...stored, kind: defaults.kind, aliases, capabilities });
}

const errorInfo = (code: LlmErrorInfo["code"], message: string, retryable = false): LlmErrorInfo => ({
  code,
  message,
  retryable,
});

export interface LlmServiceOptions {
  registry: Registry;
  events: EventBus;
  settings: SettingsStore;
}

export class LlmService {
  private readonly registry: Registry;
  private readonly events: EventBus;
  private readonly store: SettingsStore;
  private settings: GlobalSettings | null = null;
  private loading: Promise<GlobalSettings> | null = null;
  private readonly clients = new Map<string, { key: string; client: Promise<LlmClient> }>();
  private readonly controllers = new Map<string, AbortController>();

  constructor(opts: LlmServiceOptions) {
    this.registry = opts.registry;
    this.events = opts.events;
    this.store = opts.settings;
    // provider 注册或撤销后，缓存的客户端作废。
    this.registry.onChange((point, id) => {
      if (point === "llmProvider") this.clients.delete(id);
    });
  }

  /** 当前设置（首次调用时从 SettingsStore 读）。返回副本。 */
  async getSettings(): Promise<GlobalSettings> {
    return structuredClone(await this.current());
  }

  /** 重新从 SettingsStore 读；有变化时发 settings.changed。返回新设置。 */
  async reloadSettings(): Promise<GlobalSettings> {
    const prev = this.settings;
    const next = normalizeSettings(await this.store.load());
    this.settings = next;
    this.clients.clear();
    if (prev) {
      const keys = changedSettingsKeys(prev, next);
      if (keys.length) this.events.emit("settings.changed", { keys });
    }
    return structuredClone(next);
  }

  /** 保存整份设置并发 settings.changed。返回变化的路径（没有变化时不写盘、不发事件）。 */
  async saveSettings(next: GlobalSettings): Promise<string[]> {
    const prev = await this.current();
    const normalized = normalizeSettings(structuredClone(next));
    const keys = changedSettingsKeys(prev, normalized);
    if (!keys.length) return [];
    await this.store.save(normalized);
    this.settings = normalized;
    this.clients.clear();
    this.events.emit("settings.changed", { keys });
    return keys;
  }

  async listProviders(): Promise<LlmProviderInfo[]> {
    const s = await this.current();
    return this.registry.list("llmProvider").map((p) => {
      const info: LlmProviderInfo = { id: p.id, name: p.name, requiresKey: p.requiresKey, active: p.id === s.llm.activeProvider };
      if (p.keyEnvVar) info.keyEnvVar = p.keyEnvVar;
      if (p.docsUrl) info.docsUrl = p.docsUrl;
      return info;
    });
  }

  /** 某个 provider 的生效设置（默认值 + 用户覆盖）。不给 id 时取当前 provider。 */
  async providerSettings(providerId?: string): Promise<ProviderSettings | null> {
    const s = await this.current();
    const id = providerId ?? s.llm.activeProvider;
    const contrib = this.registry.get("llmProvider", id);
    return contrib ? mergeProviderSettings(contrib.defaults(), s.llm.providers[id]) : null;
  }

  /**
   * 上下文预算（token）：设置里的固定值；否则取别名对应模型上下文长度 × 比例（默认 1/4）；
   * 模型上下文长度未知时按 128k 算。
   */
  async contextBudget(alias: ModelAlias): Promise<number> {
    const s = await this.current();
    if (s.llm.budget.contextTokens) return s.llm.budget.contextTokens;
    const ps = await this.providerSettings();
    const model = ps?.aliases[alias]?.model;
    const window = (model && ps?.capabilities?.[model]?.contextWindow) || 131_072;
    return Math.floor(window * s.llm.budget.contextFraction);
  }

  /**
   * 执行一次调用。永不抛异常：错误作为 { type: "error" } 分块送出。
   * 能力检查通过后（start 分块）发 run.started；结束时总是发 run.completed（ok 表示是否正常结束）。
   */
  run(req: LlmRequest): AsyncIterable<LlmChunk> {
    return this.execute({ ...req, runId: req.runId ?? newId() }, true);
  }

  /** 取消一次调用；流里会出现 code 为 aborted 的 error 分块。未知 runId 忽略。 */
  async cancel(runId: string): Promise<void> {
    this.controllers.get(runId)?.abort();
  }

  /** 一键测试：固定提示词，不发 run.* 事件，不记 runs。可以传 runId 以便取消。 */
  test(alias: ModelAlias = "fast", opts: { runId?: string; providerId?: string } = {}): AsyncIterable<LlmChunk> {
    return this.execute({ ...testRequest(alias), runId: opts.runId ?? newId() }, false, opts.providerId);
  }

  /** 拉模型列表（能力表）。不写设置；要写进 settings 用 refreshModels。 */
  async listModels(providerId?: string): Promise<ModelCapability[] | LlmErrorInfo> {
    const c = await this.client(providerId);
    if (isLlmError(c)) return c;
    try {
      return await c.listModels();
    } catch (e) {
      return errorInfo("provider_error", String((e as Error)?.message ?? e), true);
    }
  }

  /** 拉模型列表并合并进 llm.providers.<id>.capabilities，保存设置。 */
  async refreshModels(providerId?: string): Promise<ModelCapability[] | LlmErrorInfo> {
    const s = await this.current();
    const id = providerId ?? s.llm.activeProvider;
    const models = await this.listModels(id);
    if (isLlmError(models)) return models;
    const next = structuredClone(s);
    const entry = (next.llm.providers[id] ??= {});
    entry.capabilities = { ...(entry.capabilities ?? {}) };
    for (const m of models) entry.capabilities[m.modelId] = m;
    await this.saveSettings(next);
    return models;
  }

  async credits(providerId?: string): Promise<LlmCredits | null> {
    const c = await this.client(providerId);
    if (isLlmError(c)) return null;
    try {
      return await c.credits();
    } catch {
      return null;
    }
  }

  private async current(): Promise<GlobalSettings> {
    if (this.settings) return this.settings;
    this.loading ??= this.store
      .load()
      .then((s) => (this.settings = normalizeSettings(s)))
      .catch(() => (this.settings = normalizeSettings(null)))
      .finally(() => (this.loading = null));
    return this.loading;
  }

  private async client(providerId?: string): Promise<LlmClient | LlmErrorInfo> {
    const s = await this.current();
    const id = providerId ?? s.llm.activeProvider;
    const contrib: LlmProviderContribution | undefined = this.registry.get("llmProvider", id);
    if (!contrib) return errorInfo("no_provider", `没有注册 LLM provider：${id}`);
    const config = mergeProviderSettings(contrib.defaults(), s.llm.providers[id]);
    const key = stableStringify(config);
    const cached = this.clients.get(id);
    if (cached && cached.key === key) return cached.client;
    const client = contrib.create(config);
    this.clients.set(id, { key, client });
    try {
      return await client;
    } catch (e) {
      this.clients.delete(id);
      return errorInfo("provider_error", `创建 provider 失败：${String((e as Error)?.message ?? e)}`);
    }
  }

  private async *execute(
    req: LlmRequest & { runId: string },
    emitEvents: boolean,
    providerId?: string,
  ): AsyncGenerator<LlmChunk> {
    const { runId } = req;
    const nodeId = req.nodeId ?? "";
    const ac = new AbortController();
    this.controllers.set(runId, ac);
    let ok = false;
    let ended = false;
    try {
      const c = await this.client(providerId);
      if (isLlmError(c)) {
        ended = true;
        yield { type: "error", error: c };
        return;
      }
      // 和取消赛跑：provider 不理会 signal 时也能立刻结束。
      const iter = c.stream(req, ac.signal)[Symbol.asyncIterator]();
      const abortedP = new Promise<"aborted">((resolve) => {
        if (ac.signal.aborted) resolve("aborted");
        ac.signal.addEventListener("abort", () => resolve("aborted"), { once: true });
      });
      while (true) {
        const step = await Promise.race([iter.next(), abortedP]);
        if (step === "aborted") {
          void iter.return?.()?.catch?.(() => {});
          break;
        }
        if (step.done) break;
        const chunk = step.value;
        if (chunk.type === "start" && emitEvents) {
          this.events.emit("run.started", {
            runId,
            nodeId,
            providerId: chunk.providerId,
            alias: chunk.alias,
            modelId: chunk.modelId,
          });
        }
        if (chunk.type === "finish") {
          ok = !ac.signal.aborted;
          ended = true;
        }
        if (chunk.type === "error") ended = true;
        yield chunk;
        if (ended) {
          void iter.return?.()?.catch?.(() => {});
          break;
        }
      }
      if (!ended) {
        ended = true;
        yield {
          type: "error",
          error: ac.signal.aborted
            ? errorInfo("aborted", "已取消")
            : errorInfo("provider_error", "流意外结束", true),
        };
      }
    } catch (e) {
      ok = false;
      if (!ended) {
        ended = true;
        yield {
          type: "error",
          error: ac.signal.aborted ? errorInfo("aborted", "已取消") : errorInfo("provider_error", String((e as Error)?.message ?? e), true),
        };
      }
    } finally {
      // 调用方提前退出循环时也要停掉上游请求。
      if (!ended) ac.abort();
      this.controllers.delete(runId);
      if (emitEvents) this.events.emit("run.completed", { runId, nodeId, ok });
    }
  }
}

export interface AppLlm {
  registry: Registry;
  events: EventBus;
  llm: LlmService;
}

/**
 * 不打开书也能用的 LLM 入口：首次启动引导、设置页在选书之前就要测试连接。
 * 不传 registry / events 时新建；Reader 传入自己的，二者共用同一套。
 * 不传 settings 时用内存实现（不落盘）。provider 由调用方注册（如 @reader/llm 的 registerBuiltinLlmProviders）。
 */
export function createAppLlm(opts: { settings?: SettingsStore; registry?: Registry; events?: EventBus } = {}): AppLlm {
  const registry = opts.registry ?? new Registry();
  const events = opts.events ?? new EventBus();
  const llm = new LlmService({ registry, events, settings: opts.settings ?? new MemorySettingsStore() });
  return { registry, events, llm };
}
