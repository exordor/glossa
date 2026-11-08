/**
 * 把 SDK / 网络异常映射成可序列化的 LlmErrorInfo。按 error.name 和 statusCode 判断，不引入错误类。
 * 网关错误类名来自 @ai-sdk/gateway 的类型声明；OpenAI 兼容服务商抛 APICallError（带 statusCode、responseBody）。
 */
import type { LlmErrorInfo } from "@reader/core";

const info = (code: LlmErrorInfo["code"], message: string, retryable: boolean, status?: number): LlmErrorInfo =>
  status === undefined ? { code, message, retryable } : { code, message, retryable, status };

interface ErrLike {
  name?: string;
  message?: string;
  statusCode?: number;
  status?: number;
  responseBody?: string;
  cause?: unknown;
  lastError?: unknown;
  errors?: unknown[];
  modelId?: string;
}

function bodyCode(body: string | undefined): string | null {
  if (!body) return null;
  try {
    const j = JSON.parse(body) as { error?: { code?: unknown; type?: unknown } };
    const c = j.error?.code ?? j.error?.type;
    return typeof c === "string" ? c : null;
  } catch {
    return null;
  }
}

export function toLlmErrorInfo(err: unknown): LlmErrorInfo {
  let e = (typeof err === "object" && err !== null ? err : { message: String(err) }) as ErrLike;
  // 重试耗尽：SDK 包一层 RetryError，看最后一次的错误。
  if (e.name === "AI_RetryError" && e.lastError) e = e.lastError as ErrLike;
  const name = e.name ?? "";
  const msg = e.message ?? String(err);
  const status = e.statusCode ?? e.status;
  // 网关错误类（GatewayResponseError 等）不带 responseBody，原始的 APICallError 在 cause 里。
  const cause = (typeof e.cause === "object" && e.cause !== null ? e.cause : {}) as ErrLike;
  const responseBody = e.responseBody ?? cause.responseBody;
  const body = `${responseBody ?? ""} ${msg}`;
  const code = bodyCode(responseBody);

  if (name === "ReplayMissError") return info("replay_miss", msg, false);
  if (name === "AbortError" || name === "ResponseAborted" || /aborted|abort/i.test(name)) return info("aborted", "已取消", false);
  if (/timeout/i.test(name) || name === "TimeoutError") return info("timeout", "等待超时", true);
  // dev bridge 自己的错误（没有密钥 / 生产构建没有 bridge）。
  if (code === "no_key") return info("no_key", "还没有配置 API 密钥", false, 401);
  if (code === "no_bridge") return info("no_bridge", "AI 功能需在桌面版或 pnpm dev 下使用", false, status);
  if (name === "GatewayAuthenticationError" || status === 401) return info("unauthorized", "密钥无效或已撤销", false, status ?? 401);
  if (name === "GatewayForbiddenError" || status === 403 || /RestrictedModels|no_providers_available/.test(body)) {
    return info("restricted_model", "该模型在当前额度下不可用，请充值后重试", false, status ?? 403);
  }
  if (name === "GatewayModelNotFoundError" || code === "model_not_found" || /model.*not.*(found|exist)/i.test(body)) {
    return info("model_not_found", `模型不存在：${e.modelId ?? ""}`.trim(), false, status ?? 404);
  }
  if (name === "GatewayRateLimitError" || status === 429) return info("rate_limited", "请求过于频繁，已自动重试 3 次", true, status ?? 429);
  if (status === 404) return info("no_bridge", "AI 功能需在桌面版或 pnpm dev 下使用", false, 404);
  if (status === 402) return info("restricted_model", "余额不足，请充值后重试", false, 402);
  if (
    (name === "TypeError" && /fetch|network|load failed/i.test(msg)) ||
    /ECONNREFUSED|ENOTFOUND|ECONNRESET|fetch failed|测试禁止联网/.test(body)
  ) {
    return info("network", "连不上模型服务，请检查网络", true);
  }
  if (status !== undefined && status >= 500) return info("provider_error", `服务商出错（${status}）`, true, status);
  return info("provider_error", msg || "未知错误", false, status);
}
