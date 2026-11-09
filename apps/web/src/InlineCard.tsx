/**
 * 就地卡：「词义」「拆句」的结果直接弹在原文旁（阅读器顶部），不打断阅读、不占画布。
 * 需要留下来时点「钉到画布」，生成摘录卡 + 回答卡。公开选择器 [data-rc="inline-card"] 给主题用。
 */
import { useMemo } from "react";
import { type AnswerDepth, type AssembledContext, type Citation, DEPTH_LABEL } from "@reader/core";
import { citeSummary } from "./cite";
import { Icon } from "./icons";
import { MarkdownFull } from "./mini-markdown";

const DEPTHS: AnswerDepth[] = ["brief", "points", "steps"];

export interface InlineCardState {
  runId: string;
  actionId: string;
  actionName: string;
  /** 选中的原文，卡头显示。 */
  quote: string;
  text: string;
  status: "running" | "done" | "failed";
  error?: string;
  /** 本次生成用的回答深度。 */
  depth: AnswerDepth;
  /** 生成结束后的引用校验结果。 */
  citations: Citation[];
  /** 本次发给 AI 的上下文。 */
  context?: AssembledContext;
  /** 词义查完进了生词本：这是第几次查这个词。 */
  vocabCount?: number;
}

export function InlineCard({
  card,
  onPin,
  onRetry,
  onClose,
  onDepth,
  onContext,
}: {
  card: InlineCardState;
  onPin: () => void;
  onRetry: () => void;
  onClose: () => void;
  onDepth: (depth: AnswerDepth) => void;
  onContext: () => void;
}) {
  const cites = useMemo(() => new Map(card.citations.map((c) => [c.quote, c.verified])), [card.citations]);
  const cite = card.status === "done" ? citeSummary(card.citations) : null;
  return (
    <section className="inline-card" data-rc="inline-card" data-state={card.status} aria-live="polite" aria-busy={card.status === "running"}>
      <header className="inline-card-head">
        <Icon name={card.actionId === "parse-sentence" ? "act-split" : "act-word"} />
        <span className="inline-card-title">{card.actionName}</span>
        <span className="inline-card-quote" title={card.quote}>
          {card.quote}
        </span>
        {card.status === "running" && <Icon name="st-running" className="inline-card-spin" />}
        <button className="rc-iconbtn rc-iconbtn-sm" aria-label="关闭" title="关闭" onClick={onClose}>
          <Icon name="close" />
        </button>
      </header>
      {card.text && (
        <div className="inline-card-body">
          <MarkdownFull text={card.text} cites={cites} />
        </div>
      )}
      {card.status === "running" && !card.text && <p className="inline-card-wait">正在生成…</p>}
      {card.error && (
        <p className="inline-card-error" role="alert">
          <Icon name="st-failed" />
          {card.error}
        </p>
      )}
      {cite && (
        <p className="inline-card-cite" data-warn={cite.warn}>
          <Icon name={"node-excerpt"} />
          {cite.text}
        </p>
      )}
      {card.vocabCount !== undefined && (
        <p className="inline-card-vocab" data-rc="vocab-status">
          已加入生词本 · 第 {card.vocabCount} 次查
        </p>
      )}
      <footer className="inline-card-foot">
        <span className="rc-seg" role="group" aria-label="回答深度">
          {DEPTHS.map((d) => (
            <button
              key={d}
              className="rc-seg-btn"
              aria-pressed={card.depth === d}
              disabled={card.status === "running"}
              onClick={() => onDepth(d)}
              title={`按「${DEPTH_LABEL[d]}」重新生成`}
            >
              {DEPTH_LABEL[d]}
            </button>
          ))}
        </span>
        <button className="rc-iconbtn" aria-label="本次上下文" title="本次上下文：发给 AI 的内容" disabled={!card.context} onClick={onContext}>
          <Icon name="context" />
        </button>
        {card.status === "failed" && (
          <button className="btn btn-sm" onClick={onRetry}>
            重试
          </button>
        )}
        <button className="btn btn-sm btn-primary" disabled={card.status !== "done"} onClick={onPin} title="生成摘录卡和回答卡，留在画布上">
          <Icon name="pin" />
          钉到画布
        </button>
      </footer>
    </section>
  );
}
