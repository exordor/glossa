/**
 * 服务商模型列表 → 能力表。
 * Vercel AI Gateway 的 GET /v1/models 每项带 context_window、max_tokens、modalities、tags、reasoning_options、pricing
 * （字段名经 WebFetch 摘要得到，未见原始 JSON，所以这里每个字段都做容错）。
 * OpenAI 兼容服务商的 GET /models 一般只有 id，能力表只能保守填。
 */
import type { ModelCapability, ReasoningLevel } from "@reader/core";

type Json = Record<string, unknown>;
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : 0);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const LEVELS: ReasoningLevel[] = ["none", "low", "high", "max"];

/** 网关报价是每 token 美元（字符串），换成每百万 token。缺失或无法解析时为 null。 */
function pricingOf(p: unknown): ModelCapability["pricing"] {
  if (typeof p !== "object" || p === null) return null;
  const j = p as Json;
  const input = num(j.input);
  const output = num(j.output);
  if (!input && !output) return null;
  const perM = (x: number) => Math.round(x * 1e12) / 1e6; // 去掉浮点尾巴，保留 6 位小数
  const out: NonNullable<ModelCapability["pricing"]> = { inputPerMTok: perM(input), outputPerMTok: perM(output) };
  const cached = num(j.input_cache_read ?? j.cached_input ?? j.cachedInputTokens);
  if (cached) out.cachedInputPerMTok = perM(cached);
  return out;
}

function modalities(v: unknown): { input: string[]; output: string[] } {
  if (Array.isArray(v)) return { input: strs(v), output: ["text"] };
  if (typeof v === "object" && v !== null) {
    const j = v as Json;
    return { input: strs(j.input), output: strs(j.output) };
  }
  return { input: [], output: [] };
}

/** 一项网关模型 → 能力表。不是语言模型（type 为 image / embedding 等）时返回 null。 */
export function fromGatewayModel(entry: unknown, now = new Date().toISOString()): ModelCapability | null {
  if (typeof entry !== "object" || entry === null) return null;
  const e = entry as Json;
  if (typeof e.id !== "string") return null;
  if (typeof e.type === "string" && e.type !== "language") return null;
  const tags = strs(e.tags);
  const mod = modalities(e.modalities);
  const params = strs(e.supported_parameters);
  const reasoning = strs(e.reasoning_options ?? (e.reasoning as Json | undefined)?.options).filter((l): l is ReasoningLevel =>
    (LEVELS as string[]).includes(l),
  );
  const image = tags.includes("vision") || mod.input.includes("image");
  return {
    modelId: e.id,
    label: typeof e.name === "string" ? e.name : e.id,
    input: { text: true, image, pdf: tags.includes("file-input") || mod.input.includes("file") || mod.input.includes("pdf") },
    output: { text: mod.output.length === 0 || mod.output.includes("text"), image: tags.includes("image-generation") || mod.output.includes("image") },
    contextWindow: num(e.context_window),
    maxOutputTokens: num(e.max_tokens),
    reasoningLevels: reasoning,
    structuredOutput: params.includes("response_format") || params.includes("structured_outputs") || tags.includes("structured-output") ? true : null,
    toolUse: tags.includes("tool-use") || params.includes("tools"),
    pricing: pricingOf(e.pricing),
    source: "remote",
    fetchedAt: now,
  };
}

/**
 * OpenAI 兼容 /models 的一项 → 能力表。只有 id 时用 known（内置种子）补全；都没有就按「只支持文本、长度未知」。
 */
export function fromOpenAiModel(entry: unknown, known?: ModelCapability, now = new Date().toISOString()): ModelCapability | null {
  if (typeof entry !== "object" || entry === null) return null;
  const e = entry as Json;
  if (typeof e.id !== "string") return null;
  // 有些兼容服务（OpenRouter、网关）也给 context_window 之类，能用就用。
  const richer = e.context_window !== undefined || e.modalities !== undefined ? fromGatewayModel(e, now) : null;
  if (richer) return richer;
  if (known) return { ...known, source: "remote", fetchedAt: now };
  return {
    modelId: e.id,
    label: e.id,
    input: { text: true, image: false, pdf: false },
    output: { text: true, image: false },
    contextWindow: num(e.context_length ?? e.context_window),
    maxOutputTokens: 0,
    reasoningLevels: [],
    structuredOutput: null,
    toolUse: false,
    pricing: null,
    source: "remote",
    fetchedAt: now,
  };
}

/** 解析 { data: [...] }（OpenAI 形状）或直接数组。 */
export function modelListEntries(body: unknown): unknown[] {
  if (Array.isArray(body)) return body;
  if (typeof body === "object" && body !== null && Array.isArray((body as Json).data)) return (body as Json).data as unknown[];
  return [];
}
