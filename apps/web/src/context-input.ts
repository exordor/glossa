/**
 * 从画布和原文收集上下文组装的输入（第 3–6 项）。纯数据进、纯数据出，组装本身在 @reader/core assembleContext。
 */
import type { Anchor, Book, ContextExcerpt, ContextInput, ContextNote, ContextTurn, ReaderEdge, ReaderNode } from "@reader/core";
import { parseAnswer } from "@reader/core";

/** assembleContext 的输入去掉每次调用才定的部分（动作、深度、预算、去掉的项）。 */
export type ContextBase = Omit<ContextInput, "action" | "depth" | "budget" | "exclude">;

const MAX_TURNS = 5;

/** 两个锚点是不是同一段（同来源、同标题路径、同块序号）。 */
function sameBlock(a: Anchor, b: Anchor): boolean {
  if (a.kind !== "markdown" || b.kind !== "markdown") return a.sourceId === b.sourceId && a.quote.exact === b.quote.exact;
  return a.sourceId === b.sourceId && a.blockIndex === b.blockIndex && a.headingPath.join("\u0000") === b.headingPath.join("\u0000");
}

export function contextBaseFor(opts: {
  book: Book;
  anchor: Anchor;
  /** markdownAdapter.extract 的结果（文字部分）。 */
  part: Omit<ContextExcerpt, "nodeId">;
  nodes: ReaderNode[];
  edges: ReaderEdge[];
  /** 本次的摘录卡（已经建好时），它的问答不算「之前的」。 */
  excerptNodeId?: string;
  /** 本次的回答卡（重试时），不能把自己当成之前的问答。 */
  answerNodeId?: string;
}): ContextBase {
  const { book, anchor, part, nodes, edges } = opts;
  const source = book.sources.find((s) => s.id === anchor.sourceId);
  const byId = new Map(nodes.map((n) => [n.id, n]));

  // 第 6 项：同一段上的批注。
  const notes: ContextNote[] = nodes
    .filter((n) => n.meta.type === "note" && n.meta.anchor && sameBlock(n.meta.anchor, anchor))
    .sort((a, b) => a.meta.createdAt.localeCompare(b.meta.createdAt))
    .flatMap((n) => {
      const quote = n.meta.anchor!.quote.exact;
      const text = (n.text ?? "").trim();
      return text && text !== quote ? [{ nodeId: n.id, text, quote }] : [];
    });

  // 第 5 项：同一段上之前的问答（摘录卡 → derived → 回答卡），旧的在前，最多 5 轮。
  const conversation: ContextTurn[] = edges
    .filter((e) => e.role === "derived")
    .flatMap((e) => {
      const from = byId.get(e.from);
      const to = byId.get(e.to);
      if (!from?.meta.anchor || to?.meta.type !== "answer" || to.meta.status !== "done") return [];
      if (from.id === opts.excerptNodeId || to.id === opts.answerNodeId || !sameBlock(from.meta.anchor, anchor)) return [];
      const answer = (to.text ?? "").trim();
      if (!answer) return [];
      const summary = parseAnswer(answer, to.meta.depth ?? "points").summary;
      return [{ nodeId: to.id, question: `${to.label ?? "解释"}「${from.meta.anchor.quote.exact}」`, answer, ...(summary ? { summary } : {}), at: to.meta.createdAt }];
    })
    .sort((a, b) => a.at.localeCompare(b.at))
    .slice(-MAX_TURNS)
    .map(({ at: _at, ...t }) => t);

  const base: ContextBase = {
    book: { title: book.title, ...(book.authors?.length ? { authors: book.authors } : {}) },
    excerpts: [{ ...part, ...(opts.excerptNodeId ? { nodeId: opts.excerptNodeId } : {}) }],
    conversation,
    notes,
  };
  const chapter = source?.title ?? part.headingPath[0];
  if (chapter) base.chapter = chapter;
  return base;
}
