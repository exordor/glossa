/**
 * 内置 provider 的默认别名与能力表种子。用带日期的固定模型 id，录制回放才可复现。
 * 价格一律不写死（pricing: null，界面显示「未知」），从服务商的模型列表刷新。
 */
import type { AliasMap, ModelCapability } from "@reader/core";

export const GATEWAY_ORIGIN = "https://ai-gateway.vercel.sh";
export const DEEPSEEK_ORIGIN = "https://api.deepseek.com";
export const OLLAMA_BASE_URL = "http://localhost:11434/v1";

export const GATEWAY_FLASH = "deepseek/deepseek-v4.1-flash-1017";
export const GATEWAY_PRO = "deepseek/deepseek-v4-pro-0813";

/** 开发期偏好低成本：三个别名都用 Flash 1017，只是思考强度不同；Pro 可在设置里选。 */
export const GATEWAY_DEFAULT_ALIASES: AliasMap = {
  fast: { model: GATEWAY_FLASH, reasoning: "none" },
  smart: { model: GATEWAY_FLASH, reasoning: "high" },
  vision: { model: GATEWAY_FLASH, reasoning: "low" },
  image: null,
};

/** DeepSeek 官方 API 的模型 id（未能在沙箱里核实当前列表；用户可以手填）。 */
export const DEEPSEEK_DEFAULT_ALIASES: AliasMap = {
  fast: { model: "deepseek-chat" },
  smart: { model: "deepseek-reasoner" },
  vision: null,
  image: null,
};

/** OpenAI 兼容：模型由用户填，默认都未配置。 */
export const OPENAI_COMPATIBLE_DEFAULT_ALIASES: AliasMap = { fast: null, smart: null, vision: null, image: null };

const cap = (c: Omit<ModelCapability, "source" | "fetchedAt" | "pricing" | "output"> & Partial<ModelCapability>): ModelCapability => ({
  output: { text: true, image: false },
  pricing: null,
  source: "builtin",
  fetchedAt: null,
  ...c,
});

export const GATEWAY_CAPABILITIES: Record<string, ModelCapability> = {
  [GATEWAY_FLASH]: cap({
    modelId: GATEWAY_FLASH,
    label: "DeepSeek V4.1 Flash (1017)",
    input: { text: true, image: true, pdf: true },
    contextWindow: 1_048_576,
    maxOutputTokens: 262_144,
    reasoningLevels: ["none", "low", "high", "max"],
    structuredOutput: true,
    toolUse: true,
  }),
  [GATEWAY_PRO]: cap({
    modelId: GATEWAY_PRO,
    label: "DeepSeek V4 Pro (0813)",
    input: { text: true, image: false, pdf: false },
    contextWindow: 1_048_576,
    maxOutputTokens: 262_144,
    reasoningLevels: ["none", "low", "high", "max"],
    structuredOutput: true,
    toolUse: true,
  }),
};

/** 未核实的种子值（DeepSeek 自己的 /models 只给 id），按保守值填。 */
export const DEEPSEEK_CAPABILITIES: Record<string, ModelCapability> = {
  "deepseek-chat": cap({
    modelId: "deepseek-chat",
    label: "DeepSeek Chat",
    input: { text: true, image: false, pdf: false },
    contextWindow: 131_072,
    maxOutputTokens: 8_192,
    reasoningLevels: [],
    structuredOutput: true,
    toolUse: true,
  }),
  "deepseek-reasoner": cap({
    modelId: "deepseek-reasoner",
    label: "DeepSeek Reasoner",
    input: { text: true, image: false, pdf: false },
    contextWindow: 131_072,
    maxOutputTokens: 65_536,
    reasoningLevels: [],
    structuredOutput: true,
    toolUse: false,
  }),
};
