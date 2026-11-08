/**
 * 浏览器侧的 LLM 接线：dev bridge 传输、HTTP 设置存取、密钥状态客户端、应用级 LLM（不打开书也能用）。
 * 密钥从不进浏览器：保存时 PUT 给 bridge，之后只拿得到状态和 4 位提示。
 */
import {
  type GlobalSettings,
  type LlmErrorInfo,
  MemorySettingsStore,
  type Registry,
  type SettingsStore,
  createAppLlm,
  parseSettings,
  serializeSettings,
} from "@reader/core";
import { BRIDGE_HEADER, createBridgeTransport, registerBuiltinLlmProviders } from "@reader/llm";

export const bridgeTransport = createBridgeTransport({ origin: location.origin });

/** 把内置 provider 注册到某个注册表（应用级 LLM 和每本书的 reader 各注册一次）。 */
export function registerLlmProviders(registry: Registry) {
  return registerBuiltinLlmProviders(registry, { transport: bridgeTransport });
}

const bridgeHeaders = (extra: Record<string, string> = {}) => ({ [BRIDGE_HEADER]: "1", ...extra });

/** bridge 是否存在：生产构建（vite build / preview）没有 bridge，AI 功能不可用，但阅读和批注照常。 */
export type BridgeState = "unknown" | "ok" | "missing";
let bridgeState: BridgeState = "unknown";
export const getBridgeState = () => bridgeState;

const isBridgeResponse = (res: Response) => res.headers.get(BRIDGE_HEADER) === "1";

/**
 * 设置经 dev bridge 读写 ~/.reader/settings.json。没有 bridge 时退回内存（不落盘）。
 */
export class HttpSettingsStore implements SettingsStore {
  private fallback = new MemorySettingsStore();

  async load(): Promise<GlobalSettings> {
    try {
      const res = await fetch("/__glossa/settings", { headers: bridgeHeaders() });
      if (!res.ok || !isBridgeResponse(res)) throw new Error(`HTTP ${res.status}`);
      bridgeState = "ok";
      return parseSettings(await res.text());
    } catch {
      bridgeState = "missing";
      return this.fallback.load();
    }
  }

  async save(settings: GlobalSettings): Promise<void> {
    if (bridgeState === "missing") return this.fallback.save(settings);
    const res = await fetch("/__glossa/settings", {
      method: "PUT",
      headers: bridgeHeaders({ "content-type": "application/json" }),
      body: serializeSettings(settings),
    });
    if (!res.ok) throw new Error(`保存设置失败（HTTP ${res.status}）`);
  }
}

export const settingsStore = new HttpSettingsStore();

/** 应用级 LLM：首次启动引导、开书之前的设置页用。每本书的 reader.llm 共用同一个 settingsStore。 */
export const appLlm = createAppLlm({ settings: settingsStore });
registerLlmProviders(appLlm.registry);

/** GET /__glossa/llm/key/<id> 的返回（与 dev/glossa-dev-bridge.ts 的 KeyStatusBody 一致）。 */
export interface KeyStatus {
  providerId: string;
  configured: boolean;
  source: "env" | "keychain" | "file" | null;
  hint: string | null;
  envVar: string;
  envFile: boolean;
  store: "keychain" | "file";
  requiresKey: boolean;
}

async function keyCall(providerId: string, init: RequestInit = {}): Promise<KeyStatus> {
  let res: Response;
  try {
    res = await fetch(`/__glossa/llm/key/${encodeURIComponent(providerId)}`, {
      ...init,
      headers: bridgeHeaders(init.body ? { "content-type": "application/json" } : {}),
    });
  } catch {
    throw new KeyError("no_bridge", NO_BRIDGE_TEXT);
  }
  if (!isBridgeResponse(res)) {
    bridgeState = "missing";
    throw new KeyError("no_bridge", NO_BRIDGE_TEXT);
  }
  const body = (await res.json()) as KeyStatus & { error?: { code: string; message: string } };
  if (!res.ok) throw new KeyError(body.error?.code ?? "error", body.error?.message ?? `HTTP ${res.status}`);
  return body;
}

export class KeyError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const keyStatus = (providerId: string) => keyCall(providerId);
export const saveKey = (providerId: string, apiKey: string) => keyCall(providerId, { method: "PUT", body: JSON.stringify({ apiKey }) });
export const clearKey = (providerId: string) => keyCall(providerId, { method: "DELETE" });

export const NO_BRIDGE_TEXT = "AI 功能需在桌面版或 pnpm dev 下使用";

/** 错误码 → 界面文案（设计 §7）。 */
export function llmErrorText(e: LlmErrorInfo): string {
  switch (e.code) {
    case "no_key":
      return "还没有配置 API 密钥";
    case "unauthorized":
      return "密钥无效或已撤销";
    case "rate_limited":
      return "请求过于频繁，已自动重试 3 次";
    case "network":
      return "连不上模型服务，请检查网络";
    case "timeout":
      return "等待超时";
    case "no_bridge":
      return NO_BRIDGE_TEXT;
    case "aborted":
      return "已取消";
    case "no_provider":
      return "没有可用的服务商";
    case "restricted_model":
    case "model_not_found":
    case "capability_missing":
    default:
      return e.message || "调用失败";
  }
}

/** 当前 provider 能不能调 AI：返回 null 表示可以，否则返回原因（界面提示「未配置 AI」）。 */
export async function aiReadiness(providerId: string): Promise<string | null> {
  try {
    const s = await keyStatus(providerId);
    return s.requiresKey && !s.configured ? "还没有配置 API 密钥" : null;
  } catch (e) {
    return (e as Error).message;
  }
}

/** 秒，一位小数。 */
export const seconds = (ms: number | undefined) => (ms === undefined ? "—" : `${(ms / 1000).toFixed(1)}s`);

/** 上下文长度的短写：1048576 → 1M，131072 → 128K。 */
export function shortTokens(n: number): string {
  if (!n) return "未知";
  if (n >= 1 << 20) return `${+(n / (1 << 20)).toFixed(1)}M`;
  if (n >= 1024) return `${Math.round(n / 1024)}K`;
  return String(n);
}
