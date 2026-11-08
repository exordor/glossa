import { type ReactNode, useEffect, useState } from "react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import type { SourceDoc } from "@reader/core";
import { renderToHast, type RenderOptions } from "@reader/source-markdown/render";

export interface TextRange {
  start: number;
  end: number;
}

/** 渲染后的原文。文字都包在 [data-s] span 里，选区据此换算回源文件偏移。 */
export function SourceReader({
  doc,
  resolveAsset,
  onSelect,
}: {
  doc: SourceDoc;
  resolveAsset: RenderOptions["resolveAsset"];
  onSelect: (range: TextRange | null) => void;
}) {
  const [content, setContent] = useState<ReactNode>(null);

  useEffect(() => {
    let alive = true;
    void renderToHast(doc, { resolveAsset }).then((hast) => {
      if (alive) setContent(toJsxRuntime(hast, { Fragment, jsx, jsxs }));
    });
    return () => {
      alive = false;
    };
  }, [doc, resolveAsset]);

  function handleMouseUp(e: React.MouseEvent<HTMLElement>) {
    onSelect(selectionToRange(e.currentTarget));
  }

  return (
    <article className="reader-body" onMouseUp={handleMouseUp}>
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
