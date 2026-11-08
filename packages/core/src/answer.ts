/**
 * 回答的结构：一句话结论（summary）+ 要点（points）或步骤（steps）+ 引用的原文（citations）。
 *
 * 不用 JSON 模式：模型照常写短 Markdown（第一行结论，后面列表），这里从文字里解析出结构。
 * 这样流式时先看到结论、再看到要点；任何 provider 都能用；回放录制里存的仍是可读文字。
 * 解析对半截文字也成立，流式过程中每次都可以重新解析。
 */
import type { ActionTemplate } from "./registry.js";

export type AnswerDepth = ActionTemplate["depth"];

/** 回答里用「」括起来的原话，以及它是否真的出现在原文里。 */
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

export const DEPTH_LABEL: Record<AnswerDepth, string> = { brief: "一句话", points: "要点", steps: "步骤" };

const DEPTH_RULE: Record<AnswerDepth, string> = {
  brief: "只写一句话结论，不超过 60 字，不要列表。",
  points: "第一行写一句话结论。然后空一行，用「- 」开头的要点展开，每点一两句；个数按上面的要求。",
  steps: "第一行写一句话结论。然后空一行，用「1. 」「2. 」编号按顺序列出步骤，每步一两句。",
};

/**
 * 模板提示词 + 统一的输出格式。格式由回答深度决定，模板正文只写「回答什么」。
 * depth 不填时用模板自己的深度。
 */
export function actionInstructions(t: ActionTemplate, depth: AnswerDepth = t.depth): string {
  const format = [
    "【输出格式】",
    `- ${DEPTH_RULE[depth]}`,
    "- 第一行就是结论本身，不要写「结论」「一句话结论」「要点」这类小标题，不要开场白和结尾客套。",
    "- 引用原文时用「」括起原话，逐字照抄，不翻译、不改写；没有把握是原话就不要加「」。",
    "- 只用纯文本和简单列表，可以用 **加粗** 标出关键词，不要用标题和表格。",
    "- 上面的要求和这里的格式冲突时（比如要点个数），以这里的格式为准。",
  ].join("\n");
  return t.prompt ? `${t.prompt}\n\n${format}` : format;
}

const BULLET = /^\s*[-*•]\s+/;
const ORDERED = /^\s*\d+[.、)]\s+/;
const HEADING = /^\s*#{1,6}\s+/;
/** 模型偶尔还是会写的小标题前缀，如「**结论**：」「一句话结论：」。 */
const LABEL = /^\s*(\*\*)?(一句话)?(结论|总结|回答|摘要)(\*\*)?\s*[:：]\s*(\*\*)?/;
const CITE = /「([^「」\n]{2,})」|“([^“”\n]{4,})”/g;

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
 * 把回答文字解析成结构。第一段非列表文字是结论；有序列表是步骤、无序列表是要点（两种都有时取多的）。
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
