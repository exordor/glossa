/**
 * 通用 LlmClient：三个内置 provider 共用。provider 只负责「modelId → AI SDK 语言模型」、模型列表和余额，
 * 能力检查、消息转换、流式映射、错误映射、录制回放都在这里。
 */
import type { LlmChunk, LlmClient, LlmCredits, LlmErrorInfo, LlmRequest, ModelCapability, ProviderSettings } from "@reader/core";
import { isLlmError } from "@reader/core";
import { type LanguageModel, type ProviderMetadata, streamText, wrapLanguageModel } from "ai";
import { toLlmErrorInfo } from "./errors.js";
import { toModelMessages } from "./messages.js";
import { type CallPlan, planCall } from "./plan.js";
import { RecordingConfigError, type RecordReplayOptions, recordReplayMiddleware, resolveRecordings } from "./record-replay.js";

/** AI SDK 的 V4 语言模型对象（LanguageModel 去掉字符串 id 的那一支）。 */
export type SdkLanguageModel = Exclude<LanguageModel, string>;

export interface LlmClientParts {
  providerId: string;
  settings: ProviderSettings;
  languageModel(modelId: string): SdkLanguageModel;
  listModels?(): Promise<ModelCapability[] | LlmErrorInfo>;
  credits?(): Promise<LlmCredits | null>;
  /** 附加的 providerOptions（如网关路由）。 */
  providerOptions?(plan: CallPlan): Record<string, Record<string, unknown>> | undefined;
  /** 从 finish-step 的 providerMetadata 取生成 id（网关：gateway.generationId）。 */
  generationId?(providerMetadata: unknown): string | undefined;
  /** 不传时模式取环境变量 GLOSSA_LLM_RECORDINGS，存储取 setDefaultRecordingStore 设的默认值；record/replay 下都没有就报配置错误。 */
  recordings?: RecordReplayOptions;
  /** 超时（毫秒）。缺省：首块 30 s（思考模型 90 s），块间 60 s。测试里调小。 */
  timeouts?: { firstChunkMs?: number; thinkingFirstChunkMs?: number; chunkMs?: number };
}

const aborted = (): LlmErrorInfo => ({ code: "aborted", message: "已取消", retryable: false });
const timedOut = (): LlmErrorInfo => ({ code: "timeout", message: "等待超时", retryable: true });

export function createLlmClient(parts: LlmClientParts): LlmClient {
  const recordings = resolveRecordings(parts.recordings);
  const model = (id: string): SdkLanguageModel => {
    const m = parts.languageModel(id);
    return recordings.mode === "off" ? m : wrapLanguageModel({ model: m as never, middleware: recordReplayMiddleware(recordings) });
  };

  async function* stream(req: LlmRequest & { runId: string }, signal: AbortSignal): AsyncGenerator<LlmChunk> {
    const t0 = Date.now();
    const plan = planCall(req, parts.settings);
    if (isLlmError(plan)) {
      yield { type: "error", error: plan };
      return;
    }
    yield { type: "start", runId: req.runId, providerId: parts.providerId, alias: plan.alias, modelId: plan.modelId, notes: plan.notes };
    if (signal.aborted) {
      yield { type: "error", error: aborted() };
      return;
    }
    if (recordings.mode !== "off" && !recordings.store) {
      yield { type: "error", error: toLlmErrorInfo(new RecordingConfigError(recordings.mode)) };
      return;
    }
    let firstChunkMs: number | undefined;
    let generationId: string | undefined;
    try {
      const thinking = plan.binding.reasoning !== undefined && plan.binding.reasoning !== "none";
      const r = streamText({
        model: model(plan.modelId) as never,
        instructions: req.instructions,
        messages: toModelMessages(plan.messages),
        ...(plan.binding.reasoning ? { reasoning: plan.binding.reasoning } : {}),
        maxOutputTokens: req.maxOutputTokens ?? plan.binding.maxOutputTokens,
        // 设计文档「边界情况」：限流自动退避重试 3 次（SDK 对 429 / 5xx 退避重试）。
        maxRetries: 3,
        timeout: {
          firstChunkMs: thinking ? (parts.timeouts?.thinkingFirstChunkMs ?? 90_000) : (parts.timeouts?.firstChunkMs ?? 30_000),
          chunkMs: parts.timeouts?.chunkMs ?? 60_000,
        },
        abortSignal: signal,
        providerOptions: parts.providerOptions?.(plan) as ProviderMetadata | undefined,
        // 错误走流里的 error 部件，不要打到控制台。
        onError: () => {},
      });
      for await (const p of r.stream) {
        switch (p.type) {
          case "text-delta":
          case "reasoning-delta":
            if (!p.text) break;
            firstChunkMs ??= Date.now() - t0;
            yield { type: p.type === "text-delta" ? "text" : "reasoning", delta: p.text };
            break;
          case "finish-step":
            generationId ??= parts.generationId?.(p.providerMetadata);
            break;
          case "finish": {
            const u = p.totalUsage;
            const usage: Extract<LlmChunk, { type: "finish" }>["usage"] = {};
            if (u.inputTokens !== undefined) usage.inputTokens = u.inputTokens;
            if (u.outputTokens !== undefined) usage.outputTokens = u.outputTokens;
            if (u.outputTokenDetails?.reasoningTokens !== undefined) usage.reasoningTokens = u.outputTokenDetails.reasoningTokens;
            const done: LlmChunk = { type: "finish", finishReason: p.finishReason, usage, durationMs: Date.now() - t0 };
            if (generationId) done.generationId = generationId;
            if (firstChunkMs !== undefined) done.firstChunkMs = firstChunkMs;
            yield done;
            return;
          }
          case "abort":
            // SDK 的首块 / 块间超时也是通过中止内部合并的 signal 实现的，同样发 abort 部件（reason 是 TimeoutError）。
            // 只有调用方自己的 signal 被中止才算「已取消」，否则就是超时。
            yield { type: "error", error: signal.aborted ? aborted() : timedOut() };
            return;
          case "error":
            yield { type: "error", error: signal.aborted ? aborted() : toLlmErrorInfo(p.error) };
            return;
        }
      }
      yield { type: "error", error: signal.aborted ? aborted() : { code: "provider_error", message: "流意外结束", retryable: true } };
    } catch (e) {
      const info = toLlmErrorInfo(e);
      yield { type: "error", error: signal.aborted ? aborted() : info.code === "aborted" ? timedOut() : info };
    }
  }

  return {
    stream,
    async listModels() {
      if (!parts.listModels) return Object.values(parts.settings.capabilities ?? {});
      try {
        return await parts.listModels();
      } catch (e) {
        return toLlmErrorInfo(e);
      }
    },
    async credits() {
      try {
        return (await parts.credits?.()) ?? null;
      } catch {
        return null;
      }
    },
  };
}

/** GET 一个 JSON 地址；非 2xx 抛出带 statusCode / responseBody 的错误，交给 toLlmErrorInfo。 */
export async function getJson(fetchFn: (u: string, i?: RequestInit) => Promise<Response>, url: string, headers: Record<string, string> = {}): Promise<unknown> {
  const res = await fetchFn(url, { method: "GET", headers: { accept: "application/json", ...headers } });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`) as Error & { statusCode: number; responseBody: string };
    err.statusCode = res.status;
    err.responseBody = text;
    throw err;
  }
  return text ? (JSON.parse(text) as unknown) : null;
}
