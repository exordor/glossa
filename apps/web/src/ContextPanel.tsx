/**
 * 「本次上下文」面板（设计文档「可见性」）：列出发给 AI 的每一项及其 token 数，可以去掉某项后重新生成。
 * 覆盖在画布右侧，不挤压布局。公开选择器 [data-rc="context-panel"] 给主题用。
 */
import { useEffect, useState } from "react";
import type { AssembledContext, ContextItem } from "@reader/core";
import { Icon } from "./icons";

const COMPRESSED: Record<NonNullable<ContextItem["compressed"]>, string> = {
  dropped: "超预算，已去掉",
  shortened: "超预算，已缩短",
  summarized: "超预算，只留结论",
};

const fmt = (n: number) => (n >= 10_000 ? `${(n / 1000).toFixed(0)}k` : n.toLocaleString("zh-CN"));

export function ContextPanel({
  title,
  context,
  busy,
  onRerun,
  onClose,
}: {
  title: string;
  context: AssembledContext;
  /** 正在生成时不能重跑。 */
  busy: boolean;
  onRerun: (exclude: string[]) => void;
  onClose: () => void;
}) {
  const initial = () => context.items.filter((i) => i.excluded).map((i) => i.id);
  const [exclude, setExclude] = useState<string[]>(initial);
  useEffect(() => setExclude(initial()), [context]); // eslint-disable-line react-hooks/exhaustive-deps
  const changed = exclude.slice().sort().join() !== initial().sort().join();
  const toggle = (id: string) => setExclude((xs) => (xs.includes(id) ? xs.filter((x) => x !== id) : [...xs, id]));
  const sent = context.items.filter((i) => !exclude.includes(i.id) && i.compressed !== "dropped");
  const tokens = sent.reduce((n, i) => n + i.tokens, 0);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <aside className="ctx-panel" data-rc="context-panel" aria-label="本次上下文">
      <header className="ctx-head">
        <Icon name="context" />
        <h2 className="ctx-title">本次上下文</h2>
        <span className="ctx-sub">{title}</span>
        <button className="rc-iconbtn rc-iconbtn-sm" aria-label="关闭" title="关闭" onClick={onClose}>
          <Icon name="close" />
        </button>
      </header>
      <p className="ctx-total" data-over={tokens > context.budget}>
        约 {fmt(tokens)} / {fmt(context.budget)} token
        {context.compressed && <span className="rc-badge rc-badge-stale">已压缩</span>}
      </p>
      <ol className="ctx-list">
        {context.items.map((it) => {
          const fixed = it.kind === "system" || it.kind === "question";
          const off = exclude.includes(it.id);
          return (
            <li key={it.id} className="ctx-item" data-off={off || it.compressed === "dropped"}>
              <details>
                <summary>
                  <span className="ctx-pos">{it.position}</span>
                  <span className="ctx-label">{it.label}</span>
                  {it.compressed && <span className="ctx-note">{COMPRESSED[it.compressed]}</span>}
                  <span className="ctx-tokens">{fmt(it.tokens)}</span>
                  <label className="ctx-toggle" title={fixed ? "这一项不能去掉" : off ? "加回这一项" : "去掉这一项"} onClick={(e) => e.stopPropagation()}>
                    <input type="checkbox" checked={!off} disabled={fixed || busy} onChange={() => toggle(it.id)} aria-label={`发送「${it.label}」`} />
                  </label>
                </summary>
                <pre className="ctx-text">{it.text}</pre>
              </details>
            </li>
          );
        })}
      </ol>
      <footer className="ctx-foot">
        <span className="ctx-hint">点一项展开看原文；取消勾选后重新生成。</span>
        <button className="btn btn-sm btn-primary" disabled={!changed || busy} onClick={() => onRerun(exclude)}>
          <Icon name="st-retry" />
          按勾选重新生成
        </button>
      </footer>
    </aside>
  );
}
