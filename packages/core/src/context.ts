/**
 * 上下文组装（设计文档「AI 上下文与结构化输出」、v0.1 计划第 6 步）。
 *
 * 位置顺序为 prompt caching 服务（稳定的在前），压缩优先级为预算服务（低优先级先压），两件事分开：
 *   位置  内容                                 压缩优先级（1 最先压）  超预算时
 *   1     系统提示词：动作模板 + 书名 / 当前章节   不压                    —
 *   2     本章摘要                              1                       整项去掉
 *   3     摘录，每段带 id（e1、e2…）和标题路径    不压                    —
 *   4     摘录周边原文：所在小节的前后段落        2                       缩短到前后各 1 段
 *   5     对话链：之前的问答，近的在后            3                       较远的问答只留结论
 *   6     读者批注，标为「读者的想法」            4                       保留最近 3 条
 *   7     用户问题                              不压                    —
 *
 * 输入输出都是可序列化的纯数据：界面拿 items 显示「本次上下文」面板，exclude 传回被用户去掉的项。
 */
import { type AnswerDepth, actionInstructions } from "./answer.js";
import type { ActionTemplate } from "./registry.js";

export type ContextItemKind = "system" | "summary" | "excerpt" | "around" | "conversation" | "note" | "question";

export interface ContextItem {
  /** 稳定 id：system、summary、e1、around-e1、qa-1、note-1、question。exclude 用它。 */
  id: string;
  kind: ContextItemKind;
  /** 位置（1–7）。 */
  position: number;
  /** 面板上的名字，如「摘录 e1 · 3.2 注意力」。 */
  label: string;
  text: string;
  tokens: number;
  /** 压缩优先级，1 最先压；null 表示不压。 */
  priority: number | null;
  /** 超预算时做了什么（面板上显示「已压缩」角标）。 */
  compressed?: "dropped" | "shortened" | "summarized";
  /** 用户在面板里去掉了。 */
  excluded?: boolean;
  /** 出处：节点或锚点，跳回用。 */
  nodeId?: string;
}

export interface ContextExcerpt {
  nodeId?: string;
  headingPath: string[];
  selected: string;
  sentence?: string;
  paragraph?: string;
  /** 所在小节里，所在段之前 / 之后的段落（近的在前 / 在后）。 */
  before?: string[];
  after?: string[];
}

export interface ContextTurn {
  nodeId?: string;
  question: string;
  answer: string;
  /** 答案的一句话结论（压缩时用）。 */
  summary?: string;
}

export interface ContextNote {
  nodeId?: string;
  text: string;
  /** 批注对应的原文。 */
  quote?: string;
}

export interface ContextInput {
  action: ActionTemplate;
  depth?: AnswerDepth;
  book: { title: string; authors?: string[] };
  /** 当前章节标题。 */
  chapter?: string;
  chapterSummary?: string;
  excerpts: ContextExcerpt[];
  /** 之前的问答，旧的在前。 */
  conversation?: ContextTurn[];
  /** 读者批注，旧的在前。 */
  notes?: ContextNote[];
  question?: string;
  /** token 预算（含系统提示词）。 */
  budget: number;
  /** 用户在面板里去掉的项 id。 */
  exclude?: string[];
}

export interface AssembledContext {
  instructions: string;
  message: string;
  items: ContextItem[];
  tokens: number;
  budget: number;
  /** 有项目被压缩。 */
  compressed: boolean;
  /** 压缩到底仍超预算（只剩不压的项）。 */
  overBudget: boolean;
}

/**
 * 粗估 token：中日韩字符按 1 个，其余按 4 个字符 1 个。只用于预算和面板显示，不用于计费。
 */
export function estimateTextTokens(text: string): number {
  let cjk = 0;
  for (const ch of text) if (/[　-鿿가-힯＀-￯]/.test(ch)) cjk++;
  return cjk + Math.ceil((text.length - cjk) / 4);
}

const NOTES_KEEP = 3;

function excerptText(id: string, e: ContextExcerpt, wantSentence: boolean, wantParagraph: boolean): string {
  // 三层标注沿用动作模板里的说法：【出处】【选中】【所在句】【所在段】。
  const lines = [`【摘录 ${id}】`];
  if (e.headingPath.length) lines.push(`【出处】${e.headingPath.join(" › ")}`);
  lines.push(`【选中】${e.selected}`);
  if (wantSentence && e.sentence && e.sentence !== e.selected) lines.push(`【所在句】${e.sentence}`);
  if (wantParagraph && e.paragraph && e.paragraph !== e.sentence && e.paragraph !== e.selected) lines.push(`【所在段】${e.paragraph}`);
  return lines.join("\n");
}

function aroundText(id: string, before: string[], after: string[]): string {
  const parts = [`【摘录 ${id} 周边原文】`];
  if (before.length) parts.push(`前文：\n${before.join("\n\n")}`);
  if (after.length) parts.push(`后文：\n${after.join("\n\n")}`);
  return parts.join("\n");
}

const turnText = (i: number, t: ContextTurn, short: boolean) =>
  `【之前的问答 ${i}】\n问：${t.question}\n答：${short ? (t.summary ?? t.answer.split("\n")[0] ?? "") : t.answer}`;

const noteText = (n: ContextNote) => `【读者的想法】${n.quote ? `（关于「${n.quote}」）` : ""}${n.text}`;

/** 按固定顺序组装，超预算按优先级压缩。 */
export function assembleContext(input: ContextInput): AssembledContext {
  const { action } = input;
  const depth = input.depth ?? action.depth;
  const exclude = new Set(input.exclude ?? []);
  const item = (x: Omit<ContextItem, "tokens">): ContextItem => ({ ...x, tokens: estimateTextTokens(x.text) });

  const header = [`书名：${input.book.title}${input.book.authors?.length ? `（${input.book.authors.join("、")}）` : ""}`];
  if (input.chapter) header.push(`当前章节：${input.chapter}`);
  const items: ContextItem[] = [
    item({
      id: "system",
      kind: "system",
      position: 1,
      label: "系统提示词",
      text: `${actionInstructions(action, depth)}\n\n【阅读材料】\n${header.join("\n")}`,
      priority: null,
    }),
  ];
  if (input.chapterSummary)
    items.push(item({ id: "summary", kind: "summary", position: 2, label: "本章摘要", text: `【本章摘要】\n${input.chapterSummary}`, priority: 1 }));

  const wantSentence = action.input.some((i) => i === "word" || i === "sentence");
  const wantParagraph = action.input.some((i) => i === "word" || i === "sentence" || i === "passage");
  input.excerpts.forEach((e, i) => {
    const id = `e${i + 1}`;
    const where = e.headingPath.at(-1);
    items.push(
      item({
        id,
        kind: "excerpt",
        position: 3,
        label: `摘录 ${id}${where ? ` · ${where}` : ""}`,
        text: excerptText(id, e, wantSentence, wantParagraph),
        priority: null,
        ...(e.nodeId ? { nodeId: e.nodeId } : {}),
      }),
    );
  });
  input.excerpts.forEach((e, i) => {
    const id = `e${i + 1}`;
    if (!e.before?.length && !e.after?.length) return;
    items.push(
      item({
        id: `around-${id}`,
        kind: "around",
        position: 4,
        label: `摘录 ${id} 周边原文`,
        text: aroundText(id, e.before ?? [], e.after ?? []),
        priority: 2,
      }),
    );
  });
  (input.conversation ?? []).forEach((t, i) =>
    items.push(
      item({
        id: `qa-${i + 1}`,
        kind: "conversation",
        position: 5,
        label: `之前的问答 ${i + 1}`,
        text: turnText(i + 1, t, false),
        priority: 3,
        ...(t.nodeId ? { nodeId: t.nodeId } : {}),
      }),
    ),
  );
  (input.notes ?? []).forEach((n, i) =>
    items.push(
      item({
        id: `note-${i + 1}`,
        kind: "note",
        position: 6,
        label: `读者的想法 ${i + 1}`,
        text: noteText(n),
        priority: 4,
        ...(n.nodeId ? { nodeId: n.nodeId } : {}),
      }),
    ),
  );
  if (input.question?.trim())
    items.push(item({ id: "question", kind: "question", position: 7, label: "问题", text: `【问题】${input.question.trim()}`, priority: null }));

  // 用户去掉的项（系统提示词、问题不能去掉）。
  for (const it of items) if (exclude.has(it.id) && it.kind !== "system" && it.kind !== "question") it.excluded = true;

  const total = () => items.reduce((n, it) => n + (it.excluded || it.compressed === "dropped" ? 0 : it.tokens), 0);
  const live = (kind: ContextItemKind) => items.filter((it) => it.kind === kind && !it.excluded && it.compressed !== "dropped");

  // 压缩：按优先级一级一级来，够了就停。
  const steps: Array<() => void> = [
    () => live("summary").forEach((it) => (it.compressed = "dropped")),
    () =>
      input.excerpts.forEach((e, i) => {
        const it = items.find((x) => x.id === `around-e${i + 1}` && !x.excluded);
        if (!it) return;
        const before = (e.before ?? []).slice(-1);
        const after = (e.after ?? []).slice(0, 1);
        if (before.length === (e.before ?? []).length && after.length === (e.after ?? []).length) return;
        it.text = aroundText(`e${i + 1}`, before, after);
        it.tokens = estimateTextTokens(it.text);
        it.compressed = "shortened";
      }),
    () => {
      const qa = live("conversation");
      qa.slice(0, -1).forEach((it) => {
        const n = Number(it.id.slice(3));
        const t = input.conversation![n - 1]!;
        it.text = turnText(n, t, true);
        it.tokens = estimateTextTokens(it.text);
        it.compressed = "summarized";
      });
    },
    () => live("note").slice(0, -NOTES_KEEP).forEach((it) => (it.compressed = "dropped")),
  ];
  for (const step of steps) {
    if (total() <= input.budget) break;
    step();
  }

  const used = items.filter((it) => !it.excluded && it.compressed !== "dropped");
  const [system, ...rest] = used;
  return {
    instructions: system!.text,
    message: rest.map((it) => it.text).join("\n\n"),
    items,
    tokens: total(),
    budget: input.budget,
    compressed: items.some((it) => it.compressed),
    overBudget: total() > input.budget,
  };
}
