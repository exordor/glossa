/**
 * 调用前的能力检查（设计文档「模型接入规则」：维护能力表，执行前检查，不支持则走退化）。
 * 纯函数：不联网，不读写文件。
 */
import type { AliasBinding, LlmErrorInfo, LlmMessage, LlmRequest, ModelAlias, ModelCapability, ProviderSettings } from "@reader/core";
import { imageCaption } from "./messages.js";

export interface CallPlan {
  /** 实际使用的别名（图片请求可能从 smart 换成 vision）。 */
  alias: ModelAlias;
  modelId: string;
  binding: AliasBinding;
  messages: LlmMessage[];
  capability: ModelCapability | null;
  /** 给用户看的说明，随 start 分块送出。 */
  notes: string[];
}

const fail = (message: string): LlmErrorInfo => ({ code: "capability_missing", message, retryable: false });

/** 粗估 token：中文为主的文本按 2 字符 / token。占位算法，第 6 步的上下文预算接管。 */
export function estimateTokens(req: Pick<LlmRequest, "instructions" | "messages">): number {
  let chars = req.instructions?.length ?? 0;
  for (const m of req.messages) for (const p of m.content) chars += p.type === "text" ? p.text.length : 0;
  return Math.ceil(chars / 2);
}

const hasImages = (messages: LlmMessage[]) => messages.some((m) => m.content.some((p) => p.type === "image"));

/** 能力表没有这个模型时：用户把它配成 vision 就当它能看图，其他别名当不能。 */
function supportsImage(alias: ModelAlias, cap: ModelCapability | null): boolean {
  return cap ? cap.input.image : alias === "vision";
}

export function planCall(req: LlmRequest, provider: ProviderSettings): CallPlan | LlmErrorInfo {
  const caps = provider.capabilities ?? {};
  const notes: string[] = [];
  let alias = req.alias;
  let binding = provider.aliases[alias] ?? null;

  if (!binding) {
    if (alias === "image") return fail("当前模型不支持生成图片（DeepSeek 没有图像生成模型）");
    return fail(`别名 ${alias} 还没有配置模型，请在设置里选择`);
  }
  let cap = caps[binding.model] ?? null;
  let messages = req.messages;

  if (hasImages(messages) && !supportsImage(alias, cap)) {
    const vision = alias === "vision" ? null : (provider.aliases.vision ?? null);
    const visionCap = vision ? (caps[vision.model] ?? null) : null;
    if (vision && supportsImage("vision", visionCap)) {
      alias = "vision";
      binding = vision;
      cap = visionCap;
      notes.push(`模型不支持图像，已改用 vision（${vision.model}）`);
    } else {
      messages = messages.map((m) => ({
        ...m,
        content: m.content.map((p) => (p.type === "image" ? { type: "text" as const, text: imageCaption(p.alt) } : p)),
      }));
      notes.push("模型不支持图像，已用图注代替");
    }
  }

  if (cap && cap.contextWindow > 0 && estimateTokens({ instructions: req.instructions, messages }) > cap.contextWindow) {
    return fail("内容超出模型上下文长度");
  }

  if (req.output?.type === "json" && cap?.structuredOutput === false) {
    notes.push("模型不支持结构化输出，改用提示词约束 JSON");
  }

  return { alias, modelId: binding.model, binding, messages, capability: cap, notes };
}
