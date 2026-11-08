import { useEffect, useMemo, useState } from "react";
import { Tldraw, type Editor, createShapeId, toRichText } from "tldraw";
import type { SourceDoc } from "@reader/core";
import { markdownAdapter } from "@reader/source-markdown";
import { reader } from "./reader";
import chapter1 from "../../../fixtures/sample-book/01-attention.md?raw";

/**
 * v0.1 骨架：三栏布局（左目录 48px 图标条、中间画布、右侧阅读器 40%）。
 * 画布暂用 tldraw 默认形状占位；自定义卡片 shape（问答卡合成等）是下一步。
 */
export function App() {
  const [doc, setDoc] = useState<SourceDoc | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [selection, setSelection] = useState<{ start: number; end: number } | null>(null);
  const actions = useMemo(() => reader.registry.list("action"), []);

  useEffect(() => {
    void markdownAdapter.parse("ch1", chapter1).then(setDoc);
  }, []);

  useEffect(() => {
    if (!editor || !doc) return;
    const id = createShapeId("chapter-ch1");
    if (editor.getShape(id)) return;
    editor.createShape({
      id,
      type: "geo",
      x: 0,
      y: 0,
      props: { w: 320, h: 120, richText: toRichText(doc.headings[0]?.text ?? "第 1 章") },
    });
    editor.zoomToFit();
  }, [editor, doc]);

  function onMouseUp() {
    const sel = window.getSelection();
    const host = document.querySelector('[data-rc="reader"] pre');
    if (!sel || sel.isCollapsed || !host || !host.contains(sel.anchorNode)) return setSelection(null);
    const range = sel.getRangeAt(0);
    const pre = document.createRange();
    pre.selectNodeContents(host);
    pre.setEnd(range.startContainer, range.startOffset);
    const start = pre.toString().length;
    setSelection({ start, end: start + range.toString().length });
  }

  async function runAction(actionId: string) {
    if (!doc || !selection || !editor) return;
    const anchor = markdownAdapter.selectionToAnchor(doc, { kind: "text", ...selection });
    const action = reader.registry.get("action", actionId);
    const y = 160 + editor.getCurrentPageShapes().length * 140;
    editor.createShape({
      type: "geo",
      x: 360,
      y,
      props: { w: 320, h: 120, color: action?.usesLLM ? "blue" : "orange", richText: toRichText(`${action?.name}：${anchor.quote.exact}`) },
    });
    setSelection(null);
  }

  return (
    <div className="layout">
      <nav className="rail" aria-label="目录" />
      <main className="canvas">
        <Tldraw onMount={setEditor} />
      </main>
      <aside className="reader" data-rc="reader" onMouseUp={onMouseUp}>
        {selection && (
          <div className="popover" data-rc="popover" role="toolbar">
            {actions.map((a) => (
              <button key={a.id} onClick={() => void runAction(a.id)}>
                {a.name}
              </button>
            ))}
          </div>
        )}
        <pre>{doc?.text ?? "加载中…"}</pre>
      </aside>
    </div>
  );
}
