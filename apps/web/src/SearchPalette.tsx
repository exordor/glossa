/**
 * Cmd+K 全局搜索：原文段落和画布卡片，结果可跳转。阅读器外的唯一模态浮层，纯键盘可用：
 * ↑↓ 选择，Enter 跳转，Esc 关闭。公开选择器 [data-rc="palette"] 给主题用。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { type SearchEntry, type SearchHit, search } from "@reader/core";
import { Icon } from "./icons";

export function SearchPalette({
  entries,
  onPick,
  onClose,
}: {
  entries: SearchEntry[];
  onPick: (hit: SearchHit) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const hits = useMemo(() => search(q, entries), [q, entries]);
  useEffect(() => input.current?.focus(), []);
  useEffect(() => setActive(0), [q]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, hits.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && hits[active]) {
      e.preventDefault();
      onPick(hits[active]!);
    }
  };

  return (
    <div className="palette-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette" data-rc="palette" role="dialog" aria-modal="true" aria-label="搜索" onKeyDown={onKey}>
        <div className="palette-input">
          <Icon name="search" />
          <input
            ref={input}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索原文和卡片"
            aria-label="搜索原文和卡片"
            role="combobox"
            aria-expanded={hits.length > 0}
            aria-controls="palette-results"
            aria-activedescendant={hits[active] ? `palette-hit-${active}` : undefined}
          />
          <kbd className="palette-kbd">Esc</kbd>
        </div>
        {q.trim() && (
          <ul className="palette-results" id="palette-results" role="listbox">
            {hits.length === 0 && <li className="palette-empty">没有找到「{q.trim()}」</li>}
            {hits.map((h, i) => (
              <li
                key={`${h.entry.kind}-${h.entry.id}-${h.entry.start ?? 0}`}
                id={`palette-hit-${i}`}
                role="option"
                aria-selected={i === active}
                className="palette-hit"
                onMouseEnter={() => setActive(i)}
                onClick={() => onPick(h)}
              >
                <Icon name={h.entry.kind === "source" ? "group-source" : h.entry.kind === "vocab" ? "act-word" : "node-answer"} />
                <span className="palette-hit-main">
                  <span className="palette-hit-snippet">
                    {h.snippet.slice(0, h.mark[0])}
                    <mark>{h.snippet.slice(h.mark[0], h.mark[1])}</mark>
                    {h.snippet.slice(h.mark[1])}
                  </span>
                  <span className="palette-hit-title">{h.entry.title}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
