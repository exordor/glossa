/**
 * 回答的结构：一句话结论（summary）+ 要点（points）或步骤（steps）+ 引用的原文（citations）。
 *
 * 设计文档「AI 上下文与结构化输出」：动作通过 JSON schema 输出（answerSchema），字段顺序 summary → points / steps → citations，
 * 流式时先出结论。模型没给出合法 JSON 时（个别 provider 只有 JSON 模式、或模型不听话），退回 parseAnswer 按文字解析。
 * 卡片、就地卡、nodes/<id>.md 正文都用 answerToMarkdown 的结果，显示管线只有一条。
 */
import type { ActionTemplate } from "./registry.js";

export type AnswerDepth = ActionTemplate["depth"];

/** 回答引用的原话，以及它是否真的出现在原文里。 */
export interface Citation {
  quote: string;
  verified: boolean;
}

export interface StructuredAnswer {
  schemaVersion: 1;
  depth: AnswerDepth;
  summary: string;
  /** depth = points 时的要点。 */
  points?: string[];
  /** depth = steps 时的步骤。 */
  steps?: string[];
  citations: Citation[];
}

const BULLET = /^\s*[-*•]\s+/;
const ORDERED = /^\s*\d+[.、)]\s+/;
const HEADING = /^\s*#{1,6}\s+/;
/** 模型偶尔还是会写的小标题前缀，如「**结论**：」「一句话结论：」。 */
const LABEL = /^\s*(\*\*)?(一句话)?(结论|总结|回答|摘要)(\*\*)?\s*[:：]\s*(\*\*)?/;
const CITE = /「([^「」\n]{2,})」|“([^“”\n]{4,})”/g;

export const DEPTH_LABEL: Record<AnswerDepth, string> = { brief: "一句话", points: "要点", steps: "步骤" };

/** 每层的长度预算（设计文档：模型只回答被要求的深度，每层有长度预算）。 */
const LIMITS = { summary: 120, item: 200, maxPoints: 4, maxSteps: 8, maxCitations: 4 };

/**
 * 按深度生成的 JSON schema。为兼容严格模式（OpenAI 风格）：所有字段都 required、不允许多余字段，
 * 也不用 maxLength / maxItems 这类严格模式不一定支持的关键字（长度预算写在 description 里）。
 * brief 没有列表字段，points / steps 只有各自那一个。
 */
export function answerSchema(depth: AnswerDepth): object {
  const str = (description: string) => ({ type: "string", description });
  const properties: Record<string, object> = { summary: str(`一句话结论，直接给出结论本身，不超过 ${LIMITS.summary} 字`) };
  if (depth === "points")
    properties.points = { type: "array", items: str(`一个要点，一两句，不超过 ${LIMITS.item} 字`), description: `要点，最多 ${LIMITS.maxPoints} 个` };
  if (depth === "steps")
    properties.steps = { type: "array", items: str(`一步，一两句，不超过 ${LIMITS.item} 字`), description: `按顺序的步骤，最多 ${LIMITS.maxSteps} 步` };
  properties.citations = {
    type: "array",
    description: `回答里用到的原文原话，逐字照抄，最多 ${LIMITS.maxCitations} 条；没有就给空数组`,
    items: { type: "object", properties: { quote: { type: "string", description: "原文原话" } }, required: ["quote"], additionalProperties: false },
  };
  return { type: "object", properties, required: Object.keys(properties), additionalProperties: false };
}

/** 给 LlmRequest.output 用。 */
export function answerOutput(depth: AnswerDepth): { type: "json"; schema: object; name: string; description: string } {
  return { type: "json", schema: answerSchema(depth), name: "answer", description: "阅读助手的回答：结论、要点或步骤、引用的原文" };
}

const DEPTH_RULE: Record<AnswerDepth, string> = {
  brief: "只填 summary（一句话结论，不超过 60 字）。",
  points: "summary 填一句话结论；points 填要点，每点一两句，个数按上面的要求（最多 4 个）。",
  steps: "summary 填一句话结论；steps 按顺序填步骤，每步一两句，不要在文字里再写「1.」编号。",
};

/**
 * 模板提示词 + 统一的输出格式（JSON）。格式由回答深度决定，模板正文只写「回答什么」。
 * schema 也写进提示词：只支持 JSON 模式、不支持严格 schema 的模型照样能按字段输出。
 */
export function actionInstructions(t: ActionTemplate, depth: AnswerDepth = t.depth): string {
  const format = [
    "【输出格式】只输出一个 JSON 对象，不要输出任何别的文字，不要用代码块包起来。",
    `- ${DEPTH_RULE[depth]}`,
    "- summary 就是结论本身，不要写「结论：」之类的标签，不要开场白和结尾客套，不要重述问题。",
    "- citations 填你用到的原文原话（逐字照抄，不翻译、不改写），没有就给空数组。正文里提到原话时用「」括起。",
    "- 文字里可以用 **加粗** 标出关键词，不要用标题和表格。",
    "- 上面的要求和这里的格式冲突时（比如要点个数），以这里的格式为准。",
    `- JSON schema：${JSON.stringify(answerSchema(depth))}`,
  ].join("\n");
  return t.prompt ? `${t.prompt}\n\n${format}` : format;
}

const asText = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const asList = (v: unknown): string[] => (Array.isArray(v) ? v.map(asText).filter(Boolean) : []);

/**
 * 模型给的对象（可能是流式时的半截）→ StructuredAnswer。字段缺失、类型不对都容忍。
 * sources 给了就校验引用（citations 字段 + 正文里「」括起的原话），否则全标未校验。
 */
export function answerFromObject(obj: unknown, depth: AnswerDepth, sources?: string[]): StructuredAnswer {
  const o = (obj && typeof obj === "object" ? obj : {}) as Record<string, unknown>;
  const out: StructuredAnswer = { schemaVersion: 1, depth, summary: asText(o.summary).replace(LABEL, ""), citations: [] };
  const points = asList(o.points);
  const steps = asList(o.steps).map((x) => x.replace(ORDERED, ""));
  if (steps.length) out.steps = steps;
  else if (points.length) out.points = points.map((x) => x.replace(BULLET, ""));
  const quotes = [
    ...(Array.isArray(o.citations) ? o.citations.map((c) => asText((c as { quote?: unknown } | null)?.quote ?? c)) : []),
    ...citationsOf([out.summary, ...(out.points ?? out.steps ?? [])].join("\n")),
  ].filter((q) => q.length >= 2);
  out.citations = [...new Set(quotes)].map((quote) => ({ quote, verified: sources ? isQuoteInSources(quote, sources) : false }));
  return out;
}

/** StructuredAnswer → 显示用的短 Markdown：结论一段，空一行，「- 」要点或「1. 」步骤。 */
export function answerToMarkdown(a: Pick<StructuredAnswer, "summary" | "points" | "steps">): string {
  const items = a.steps?.map((x, i) => `${i + 1}. ${x}`) ?? a.points?.map((x) => `- ${x}`) ?? [];
  return [a.summary, items.join("\n")].filter(Boolean).join("\n\n");
}

/** 从回答文字里取出所有引用的原话（去重，保持出现顺序）。 */
export function citationsOf(text: string): string[] {
  const seen = new Set<string>();
  for (const m of text.matchAll(CITE)) {
    const q = (m[1] ?? m[2] ?? "").trim();
    if (q) seen.add(q);
  }
  return [...seen];
}

/** 比对用的规范化：全半角、大小写、空白、Markdown 记号、引号和首尾标点都不计。 */
export function normalizeForMatch(s: string): string {
  return s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[*_`~#>]/g, "")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[\s.,;:!?'"，。；：！？、]+|[\s.,;:!?'"，。；：！？、]+$/g, "");
}

/**
 * 原话是否出现在原文里。允许中间用省略号（… 或 ...）跳过一段：各段按顺序都能找到就算。
 * sources 是原文（章节全文、所在段等），任一处命中即可。
 */
export function isQuoteInSources(quote: string, sources: string[]): boolean {
  const pieces = quote
    .split(/…+|\.{3,}/)
    .map(normalizeForMatch)
    .filter((p) => p.length >= 2);
  if (!pieces.length) return false;
  return sources.some((src) => {
    const hay = normalizeForMatch(src);
    let from = 0;
    for (const p of pieces) {
      const i = hay.indexOf(p, from);
      if (i < 0) return false;
      from = i + p.length;
    }
    return true;
  });
}

export function verifyCitations(text: string, sources: string[]): Citation[] {
  return citationsOf(text).map((quote) => ({ quote, verified: isQuoteInSources(quote, sources) }));
}

/**
 * 退路：模型没给出合法 JSON 时，把回答文字解析成结构。第一段非列表文字是结论；有序列表是步骤、无序列表是要点（两种都有时取多的）。
 * 列表项后面不带列表符号的续行并进上一项。sources 给了才校验引用，否则 citations 全标未校验（false）。
 */
export function parseAnswer(text: string, depth: AnswerDepth, sources?: string[]): StructuredAnswer {
  const summaryLines: string[] = [];
  const points: string[] = [];
  const steps: string[] = [];
  let last: string[] | null = null;
  let summaryDone = false;
  for (const raw of text.replace(/\r/g, "").split("\n")) {
    const line = raw.trim();
    if (!line) {
      if (summaryLines.length) summaryDone = true;
      last = null;
      continue;
    }
    if (BULLET.test(raw)) {
      points.push(raw.replace(BULLET, "").trim());
      last = points;
      summaryDone = true;
    } else if (ORDERED.test(raw)) {
      steps.push(raw.replace(ORDERED, "").trim());
      last = steps;
      summaryDone = true;
    } else if (last && last.length) {
      last[last.length - 1] += " " + line;
    } else if (!summaryDone) {
      summaryLines.push(line.replace(HEADING, "").replace(LABEL, ""));
    }
  }
  const out: StructuredAnswer = {
    schemaVersion: 1,
    depth,
    summary: summaryLines.join(" ").trim(),
    citations: sources ? verifyCitations(text, sources) : citationsOf(text).map((quote) => ({ quote, verified: false })),
  };
  if (steps.length > points.length) out.steps = steps;
  else if (points.length) out.points = points;
  return out;
}
