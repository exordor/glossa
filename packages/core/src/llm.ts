/**
 * LLM 网关的可序列化类型（设计文档「模型接入规则」、v0.1 计划第 4 步）。
 * @reader/core 不依赖 AI SDK：这里只有数据形状和 provider 的接口约定，具体实现在 @reader/llm。
 */
import type { ModelAlias } from "./registry.js";

/** 思考强度。"none" 关闭思考；不填表示用服务商默认。 */
export type ReasoningLevel = "none" | "low" | "high" | "max";

/** 消息片段。从第一天起按多模态写（设计文档「PDF 接入」）。 */
export type LlmPart =
  | { type: "text"; text: string }
  | { type: "image"; mediaType: string; dataBase64: string; alt?: string };

export interface LlmMessage {
  role: "user" | "assistant";
  content: LlmPart[];
}

/** 一次调用的请求。动作模板只写别名，不写具体模型。 */
export interface LlmRequest {
  alias: ModelAlias;
  instructions?: string;
  messages: LlmMessage[];
  maxOutputTokens?: number;
  /** 调用方可以自己给 runId（便于在第一个分块到达前就能取消）；不给则自动生成。 */
  runId?: string;
  nodeId?: string;
  actionId?: string;
  /** 结构化输出：JSON schema。模型不支持严格模式时，调用方应同时在提示词里写明字段。 */
  output?: { type: "json"; schema: object; name?: string; description?: string };
}

export interface LlmUsage {
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
}

/** 流式分块。文本增量是高频数据，不走事件总线，调用方迭代 AsyncIterable 拿。 */
export type LlmChunk =
  | {
      type: "start";
      runId: string;
      providerId: string;
      alias: ModelAlias;
      modelId: string;
      /** 能力检查留下的说明，如「模型不支持图像，已改用 vision」。卡片上用说明文字显示。 */
      notes: string[];
    }
  | { type: "reasoning"; delta: string }
  | { type: "text"; delta: string }
  /**
   * 结构化输出（请求带 output 时）：随文本增量不断给出当前能解析出的对象。
   * final 为 true 的那一块是完整、合法的 JSON；模型没给出合法 JSON 时不会有 final 块，调用方退回按文字处理。
   */
  | { type: "object"; value: unknown; final: boolean }
  | {
      type: "finish";
      finishReason: string;
      usage: LlmUsage;
      generationId?: string;
      /** 从请求开始到第一个文本或思考增量的毫秒数。 */
      firstChunkMs?: number;
      durationMs: number;
    }
  | { type: "error"; error: LlmErrorInfo };

export type LlmErrorCode =
  | "no_bridge"
  | "no_key"
  | "unauthorized"
  | "restricted_model"
  | "model_not_found"
  | "rate_limited"
  | "capability_missing"
  | "network"
  | "timeout"
  | "aborted"
  | "provider_error"
  | "replay_miss"
  | "no_provider";

export interface LlmErrorInfo {
  code: LlmErrorCode;
  message: string;
  retryable: boolean;
  status?: number;
}

/** 别名 → 具体模型。null 表示该别名不可用（如 DeepSeek 没有图像生成）。 */
export interface AliasBinding {
  model: string;
  reasoning?: ReasoningLevel;
  maxOutputTokens?: number;
}

export type AliasMap = Record<ModelAlias, AliasBinding | null>;

/** 能力表的一项（设计文档 AX：图像输入、上下文长度、单价）。 */
export interface ModelCapability {
  modelId: string;
  label: string;
  input: { text: boolean; image: boolean; pdf: boolean };
  output: { text: boolean; image: boolean };
  /** 0 表示未知。 */
  contextWindow: number;
  /** 0 表示未知。 */
  maxOutputTokens: number;
  reasoningLevels: ReasoningLevel[];
  structuredOutput: boolean | null;
  toolUse: boolean;
  /** 美元 / 百万 token；null 表示未知（界面显示「未知」）。 */
  pricing: { inputPerMTok: number; outputPerMTok: number; cachedInputPerMTok?: number } | null;
  /** builtin：内置种子；remote：从服务商的模型列表刷新。 */
  source: "builtin" | "remote";
  fetchedAt: string | null;
}

/**
 * 一个 provider 的设置（settings.json 的 llm.providers.<id>）。
 * 别名按 provider 分开存：切换 provider 时各自的选择都保留。不含密钥。
 */
export interface ProviderSettings {
  /** provider 实现 id，等于注册表里的 llmProvider id。 */
  kind: string;
  aliases: AliasMap;
  /** OpenAI 兼容类 provider 的上游地址。 */
  baseURL?: string;
  /** Vercel AI Gateway 的路由选项：order / only / zeroDataRetention。 */
  routing?: Record<string, unknown>;
  /** 能力表，按 modelId。 */
  capabilities?: Record<string, ModelCapability>;
  /** 未知字段读入时保留。 */
  [key: string]: unknown;
}

export interface LlmCredits {
  balance: string;
  totalUsed: string | null;
  currency?: string;
}

/** provider 实现交给 LlmService 的客户端。内部 SPI：signal 只在 core 与 provider 之间传，不出现在公共 API。 */
export interface LlmClient {
  /** 永不抛异常：错误作为 error 分块送出。第一个分块是 start 或 error。 */
  stream(req: LlmRequest & { runId: string }, signal: AbortSignal): AsyncIterable<LlmChunk>;
  /** 拉模型列表并映射为能力表。失败时返回错误。 */
  listModels(): Promise<ModelCapability[] | LlmErrorInfo>;
  /** 余额；服务商不支持或失败时返回 null。 */
  credits(): Promise<LlmCredits | null>;
}

/** 注册表 llmProvider 扩展点的实现（内置三个：vercel-gateway、deepseek、openai-compatible）。 */
export interface LlmProviderContribution {
  id: string;
  name: string;
  /** 该 provider 的密钥环境变量名（界面提示用）；不需要密钥时省略。 */
  keyEnvVar?: string;
  /** Ollama 之类本地服务不需要密钥。 */
  requiresKey: boolean;
  /** 获取密钥的说明链接。 */
  docsUrl?: string;
  /** 默认设置（别名、baseURL、内置能力表）。用户没改过的字段从这里取。 */
  defaults(): ProviderSettings;
  create(settings: ProviderSettings): Promise<LlmClient>;
}

export function isLlmError(v: unknown): v is LlmErrorInfo {
  return typeof v === "object" && v !== null && "code" in v && "retryable" in v && "message" in v;
}
