/**
 * 就地卡：「词义」「拆句」的结果直接弹在原文旁（阅读器顶部），不打断阅读、不占画布。
 * 需要留下来时点「钉到画布」，生成摘录卡 + 回答卡。公开选择器 [data-rc="inline-card"] 给主题用。
 */
import { Icon } from "./icons";
import { MarkdownFull } from "./mini-markdown";

export interface InlineCardState {
  runId: string;
  actionId: string;
  actionName: string;
  /** 选中的原文，卡头显示。 */
  quote: string;
  text: string;
  status: "running" | "done" | "failed";
  error?: string;
}

export function InlineCard({
  card,
  onPin,
  onRetry,
  onClose,
}: {
  card: InlineCardState;
  onPin: () => void;
  onRetry: () => void;
  onClose: () => void;
}) {
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
          <MarkdownFull text={card.text} />
        </div>
      )}
      {card.status === "running" && !card.text && <p className="inline-card-wait">正在生成…</p>}
      {card.error && (
        <p className="inline-card-error" role="alert">
          <Icon name="st-failed" />
          {card.error}
        </p>
      )}
      <footer className="inline-card-foot">
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
