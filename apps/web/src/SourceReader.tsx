import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import { type GutterMark, type MarkSegment, type SourceDoc, gutterLabel } from "@reader/core";
import { renderToHast, type RenderOptions } from "@reader/source-markdown/render";
import { decorateHast } from "./reader-marks";

export interface TextRange {
  start: number;
  end: number;
}

/** 原文里一个位置被指到（悬停 / 单击批注标记）：源偏移 + 屏幕位置（浮层贴着它放）。 */
export interface MarkPoint {
  offset: number;
  rect: { left: number; top: number; bottom: number };
}

type Hast = Awaited<ReturnType<typeof renderToHast>>;

/**
 * 渲染后的原文。文字都包在 [data-s] span 里，选区据此换算回源文件偏移。
 * 批注标记：句子背景、短语 / 生词下划线切进 HAST；段落边沟画在左侧一层，按块的实际位置摆。
 */
export function SourceReader({
  doc,
  resolveAsset,
  onSelect,
  segments = [],
  gutters = [],
  onMarkHover,
  onMarkClick,
  onGutter,
}: {
  doc: SourceDoc;
  resolveAsset: RenderOptions["resolveAsset"];
  onSelect: (range: TextRange | null) => void;
  segments?: readonly MarkSegment[];
  gutters?: readonly GutterMark[];
  onMarkHover?: (p: MarkPoint | null) => void;
  onMarkClick?: (p: MarkPoint) => void;
  onGutter?: (g: GutterMark, rect: MarkPoint["rect"]) => void;
}) {
  const [hast, setHast] = useState<Hast | null>(null);
  const body = useRef<HTMLElement>(null);
  const [rows, setRows] = useState<Array<{ g: GutterMark; top: number; height: number }>>([]);

  useEffect(() => {
    let alive = true;
    void renderToHast(doc, { resolveAsset }).then((h) => {
      if (alive) setHast(h);
    });
    return () => {
      alive = false;
    };
  }, [doc, resolveAsset]);

  const content = useMemo<ReactNode>(
    () => (hast ? toJsxRuntime(decorateHast(hast as Parameters<typeof decorateHast>[0], segments) as Hast, { Fragment, jsx, jsxs }) : null),
    [hast, segments],
  );

  // 边沟：量每个有批注的块在正文里的位置；正文尺寸变了（图片加载、窗口拖宽）重新量。
  useLayoutEffect(() => {
    const root = body.current;
    if (!root || !gutters.length) return setRows([]);
    const measure = () => {
      const base = root.getBoundingClientRect().top;
      setRows(
        gutters.flatMap((g) => {
          const el = root.querySelector<HTMLElement>(`[data-block-s="${g.start}"]`);
          if (!el) return [];
          const r = el.getBoundingClientRect();
          return [{ g, top: r.top - base, height: r.height }];
        }),
      );
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(root);
    return () => ro.disconnect();
  }, [gutters, content]);

  function handleMouseUp(e: React.MouseEvent<HTMLElement>) {
    onSelect(selectionToRange(e.currentTarget));
  }

  const pointOf = (target: EventTarget | null): MarkPoint | null => {
    const mark = (target as HTMLElement | null)?.closest?.<HTMLElement>("[data-rc=mark]");
    const span = (target as HTMLElement | null)?.closest?.<HTMLElement>("[data-s]") ?? mark?.querySelector<HTMLElement>("[data-s]");
    if (!mark || !span) return null;
    const r = mark.getBoundingClientRect();
    return { offset: Number(span.dataset.s), rect: { left: r.left, top: r.top, bottom: r.bottom } };
  };

  return (
    <article
      ref={body}
      className="reader-body"
      onMouseUp={handleMouseUp}
      onMouseOver={(e) => onMarkHover?.(pointOf(e.target))}
      onMouseLeave={() => onMarkHover?.(null)}
      onClick={(e) => {
        // 拖选文字不算点击。
        if (!onMarkClick || !window.getSelection()?.isCollapsed) return;
        const p = pointOf(e.target);
        if (p) onMarkClick(p);
      }}
    >
      {rows.length > 0 && (
        <div className="rc-gutters" aria-hidden={false}>
          {rows.map(({ g, top, height }) => (
            <div key={g.start} className="rc-gutter-row" style={{ top, height }}>
              <button
                type="button"
                className="rc-gutter-count"
                data-rc="gutter"
                data-group={g.group}
                aria-label={`本段 ${g.count} 条批注`}
                onClick={(e) => {
                  const r = e.currentTarget.getBoundingClientRect();
                  onGutter?.(g, { left: r.left, top: r.top, bottom: r.bottom });
                }}
              >
                {gutterLabel(g.count)}
              </button>
              <span className="rc-gutter" data-group={g.group} />
            </div>
          ))}
        </div>
      )}
      {content}
    </article>
  );
}

/** DOM 选区 → 源文件字符偏移。端点不在文字 span 里（例如落在图片或公式上）时取最近的 span 边界。 */
export function selectionToRange(root: HTMLElement): TextRange | null {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) return null;
  const start = pointToOffset(root, range.startContainer, range.startOffset, "start");
  const end = pointToOffset(root, range.endContainer, range.endOffset, "end");
  if (start === null || end === null || end <= start) return null;
  return { start, end };
}

function pointToOffset(root: HTMLElement, node: Node, offset: number, side: "start" | "end"): number | null {
  const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element);
  const span = el?.closest<HTMLElement>("[data-s]");
  if (span && root.contains(span) && node.nodeType === Node.TEXT_NODE) {
    const s = Number(span.dataset.s);
    const e = Number(span.dataset.e);
    return Math.min(s + offset, e);
  }
  // 落在元素边界上：找前后最近的文字 span。
  const spans = [...root.querySelectorAll<HTMLElement>("[data-s]")];
  const probe = document.createRange();
  probe.setStart(node, offset);
  if (side === "start") {
    const next = spans.find((sp) => probe.comparePoint(sp, 0) >= 0);
    return next ? Number(next.dataset.s) : null;
  }
  const prev = [...spans].reverse().find((sp) => probe.comparePoint(sp, sp.childNodes.length) <= 0);
  return prev ? Number(prev.dataset.e) : null;
}
