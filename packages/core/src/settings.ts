/**
 * 全局设置 ~/.reader/settings.json（设计文档「存储与文件格式」）：provider、模型别名映射、能力表、预算。
 * 只经 SettingsStore 读写；键按固定顺序序列化；读入时保留所有未知字段；从不保存密钥。
 */
import type { AliasMap, ProviderSettings } from "./llm.js";
import { stableStringify } from "./stable-json.js";
import { SCHEMA_VERSION } from "./types.js";

/** settings.json 里一个 provider 的条目：只存用户改过的部分，其余取 provider 的 defaults()。 */
export interface StoredProviderSettings {
  kind?: string;
  aliases?: Partial<AliasMap>;
  baseURL?: string;
  routing?: Record<string, unknown>;
  capabilities?: ProviderSettings["capabilities"];
  [key: string]: unknown;
}

export interface LlmSettings {
  /** 当前使用的 provider id（注册表 llmProvider）。 */
  activeProvider: string;
  providers: Record<string, StoredProviderSettings>;
  /** 上下文预算：默认取模型上下文长度的 1/4；contextTokens 非空时用固定值。 */
  budget: { contextFraction: number; contextTokens: number | null };
  [key: string]: unknown;
}

export type OnboardingStatus = "pending" | "done" | "skipped";

export interface GlobalSettings {
  schemaVersion: number;
  llm: LlmSettings;
  onboarding: { status: OnboardingStatus; updatedAt: string | null };
  [key: string]: unknown;
}

export const SETTINGS_KEY_ORDER = ["schemaVersion", "llm", "onboarding"] as const;

export const DEFAULT_PROVIDER_ID = "vercel-gateway";

export function defaultSettings(): GlobalSettings {
  return {
    schemaVersion: SCHEMA_VERSION,
    llm: {
      activeProvider: DEFAULT_PROVIDER_ID,
      providers: {},
      budget: { contextFraction: 0.25, contextTokens: null },
    },
    onboarding: { status: "pending", updatedAt: null },
  };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** 把任意 JSON 值整理成 GlobalSettings：缺的字段补默认值，类型不对的字段换成默认值，未知字段原样保留。 */
export function normalizeSettings(raw: unknown): GlobalSettings {
  const d = defaultSettings();
  if (!isObj(raw)) return d;
  const llmRaw = isObj(raw.llm) ? raw.llm : {};
  const budgetRaw = isObj(llmRaw.budget) ? llmRaw.budget : {};
  const onbRaw = isObj(raw.onboarding) ? raw.onboarding : {};
  const providers: Record<string, StoredProviderSettings> = {};
  if (isObj(llmRaw.providers)) {
    for (const [id, p] of Object.entries(llmRaw.providers)) if (isObj(p)) providers[id] = stripSecrets(p) as StoredProviderSettings;
  }
  const status = onbRaw.status;
  return {
    ...raw,
    schemaVersion: typeof raw.schemaVersion === "number" ? raw.schemaVersion : d.schemaVersion,
    llm: {
      ...llmRaw,
      activeProvider: typeof llmRaw.activeProvider === "string" ? llmRaw.activeProvider : d.llm.activeProvider,
      providers,
      budget: {
        ...budgetRaw,
        contextFraction:
          typeof budgetRaw.contextFraction === "number" ? budgetRaw.contextFraction : d.llm.budget.contextFraction,
        contextTokens: typeof budgetRaw.contextTokens === "number" ? budgetRaw.contextTokens : null,
      },
    },
    onboarding: {
      ...onbRaw,
      status: status === "done" || status === "skipped" || status === "pending" ? status : "pending",
      updatedAt: typeof onbRaw.updatedAt === "string" ? onbRaw.updatedAt : null,
    },
  };
}

/** 解析 settings.json 文本。JSON 不合法或顶层不是对象时抛 SyntaxError（调用方负责备份坏文件）。 */
export function parseSettings(text: string): GlobalSettings {
  const raw: unknown = JSON.parse(text);
  if (!isObj(raw)) throw new SyntaxError("settings.json 顶层必须是对象");
  return normalizeSettings(raw);
}

/** 序列化：固定键序、制表符缩进、结尾换行；任何层级的 apiKey 字段都会被去掉。 */
export function serializeSettings(s: GlobalSettings): string {
  return stableStringify(stripSecrets(s), SETTINGS_KEY_ORDER);
}

const SECRET_KEYS = new Set(["apiKey", "api_key", "apikey"]);

function stripSecrets(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripSecrets);
  if (!isObj(v)) return v;
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v)) if (!SECRET_KEYS.has(k)) out[k] = stripSecrets(val);
  return out;
}

/**
 * 两份设置之间变化的路径，最多两层，如 ["llm.activeProvider", "llm.providers", "onboarding.status"]。
 * 用作 settings.changed 事件的 keys。
 */
export function changedSettingsKeys(a: GlobalSettings, b: GlobalSettings): string[] {
  const out: string[] = [];
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of [...keys].sort()) {
    const va = a[k];
    const vb = b[k];
    if (isObj(va) && isObj(vb)) {
      const sub = new Set([...Object.keys(va), ...Object.keys(vb)]);
      for (const s of [...sub].sort()) if (!sameJson(va[s], vb[s])) out.push(`${k}.${s}`);
    } else if (!sameJson(va, vb)) out.push(k);
  }
  return out;
}

const sameJson = (x: unknown, y: unknown) => stableStringify(x ?? null) === stableStringify(y ?? null);

/**
 * 设置的存取接口。浏览器开发期走 dev bridge（HTTP），Node（CLI、测试）用 @reader/core/node 的 NodeSettingsStore，
 * 以后 Tauri 换成 Rust 命令。load() 文件不存在或损坏时返回默认值，不抛异常。
 */
export interface SettingsStore {
  load(): Promise<GlobalSettings>;
  save(settings: GlobalSettings): Promise<void>;
}

/** 内存实现：测试、生产构建（没有 bridge）时的兜底。 */
export class MemorySettingsStore implements SettingsStore {
  private text: string | null;
  constructor(initial?: GlobalSettings) {
    this.text = initial ? serializeSettings(initial) : null;
  }
  async load(): Promise<GlobalSettings> {
    return this.text === null ? defaultSettings() : parseSettings(this.text);
  }
  async save(settings: GlobalSettings): Promise<void> {
    this.text = serializeSettings(settings);
  }
  /** 测试用：看落盘文本。 */
  snapshot(): string | null {
    return this.text;
  }
}
