/**
 * 叠层批注浮层（设计系统 AnnotationStack）：一个位置同时命中多层批注时，按范围从窄到宽列出。
 * 每行：类型图标、颗粒度、前 20 字、定位按钮。role=listbox，↑↓ 移动，Enter 打开，Esc 关闭。
 * 公开选择器 [data-rc="annotation-stack"] 给主题用。
 */
import { useEffect, useRef, useState } from "react";
import type { AnnotationMark } from "@reader/core";
import { Icon } from "./icons";

const GRAN: Record<AnnotationMark["granularity"], string> = { word: "词", phrase: "短语", sentence: "句子", block: "段落" };

export function AnnotationStack({
  items,
  at,
  focus,
  onOpen,
  onLocate,
  onClose,
  onHover,
  hint,
}: {
  items: readonly AnnotationMark[];
  /** 贴着这个位置往下放（屏幕坐标）。 */
  at: { left: number; bottom: number };
  /** 键盘打开（点边沟角标）时把焦点放进来。 */
  focus: boolean;
  onOpen: (m: AnnotationMark) => void;
  onLocate: (m: AnnotationMark) => void;
  onClose: () => void;
  onHover?: (inside: boolean) => void;
  hint?: string;
}) {
  const [active, setActive] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focus) box.current?.focus();
  }, [focus]);
  useEffect(() => setActive(0), [items]);
  // 点浮层外面就关。
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [onClose]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, items.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && items[active]) {
      e.preventDefault();
      onOpen(items[active]!);
    }
  };

  const left = Math.max(8, Math.min(at.left, window.innerWidth - 336));
  return (
    <div
      ref={box}
      className="rc-popover rc-stack"
      data-rc="annotation-stack"
      role="listbox"
      tabIndex={-1}
      aria-label={`此处的 ${items.length} 条批注`}
      aria-activedescendant={items[active] ? `stack-${items[active]!.id}` : undefined}
      style={{ left, top: at.bottom + 6 }}
      onKeyDown={onKey}
      onMouseEnter={() => onHover?.(true)}
      onMouseLeave={() => onHover?.(false)}
    >
      {items.map((m, i) => (
        <div
          key={m.id}
          id={`stack-${m.id}`}
          className="rc-stack-row"
          role="option"
          aria-selected={i === active}
          data-group={m.group}
          onMouseEnter={() => setActive(i)}
          onClick={() => onOpen(m)}
        >
          <Icon name={m.group === "user" ? "node-note" : "node-excerpt"} />
          <span className="rc-gran">{GRAN[m.granularity]}</span>
          <span className="rc-txt">{m.label}</span>
          <button
            type="button"
            className="rc-iconbtn rc-iconbtn-sm"
            aria-label="在原文中定位"
            title="在原文中定位"
            onClick={(e) => {
              e.stopPropagation();
              onLocate(m);
            }}
          >
            <Icon name="locate" />
          </button>
        </div>
      ))}
      {hint && <div className="rc-stack-hint">{hint}</div>}
    </div>
  );
}
