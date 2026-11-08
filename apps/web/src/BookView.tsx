import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type Editor, Tldraw } from "tldraw";
import type { ReaderNode, SourceDoc } from "@reader/core";
import { markdownAdapter } from "@reader/source-markdown";
import { loadChapterAssets } from "./assets";
import { nodeIdOf, shapeIdOf, syncShapes } from "./canvas-sync";
import type { BookSession } from "./session";
import { SourceReader, type TextRange } from "./SourceReader";

/** 新卡放在来源（章节卡）下方向下堆叠。 */
const STACK = { top: 160, step: 140 } as const;

const cameraOf = (editor: Editor) => {
  const { x, y, z } = editor.getCamera();
  return { x, y, z };
};

function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number) {
  let t: ReturnType<typeof setTimeout> | undefined;
  return (...a: A) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

export function BookView({ session, onClose }: { session: BookSession; onClose: () => void }) {
  const { reader, book } = session;
  const [editor, setEditor] = useState<Editor | null>(null);
  const [openSourceId, setOpenSourceId] = useState<string | null>(null);
  const [chapter, setChapter] = useState<{ doc: SourceDoc; path: string; resolveAsset: (s: string) => string | null } | null>(null);
  const [selection, setSelection] = useState<TextRange | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const actions = useMemo(() => reader.registry.list("action"), [reader]);
  const nodesRef = useRef<ReaderNode[]>([]);

  const save = useMemo(
    () =>
      debounce(() => {
        reader.save().then(
          () => setSaveError(null),
          (e: Error) => setSaveError(e.message),
        );
      }, 400),
    [reader],
  );

  // 打开书：恢复上次打开的章节（没有就第一章）
  useEffect(() => {
    void reader.getView().then((v) => {
      const id = v?.openSourceId && book.sources.some((s) => s.id === v.openSourceId) ? v.openSourceId : book.sources[0]?.id;
      setOpenSourceId(id ?? null);
    });
  }, [reader, book]);

  // 画布：建 shape、恢复视口、监听拖动与选中
  useEffect(() => {
    if (!editor) return;
    let disposed = false;
    const cleanups: Array<() => void> = [];
    void (async () => {
      nodesRef.current = await reader.listNodes();
      if (disposed) return;
      syncShapes(editor, nodesRef.current);
      const view = await reader.getView();
      if (view?.camera) editor.setCamera(view.camera);
      else editor.zoomToFit({ animation: { duration: 0 } });

      cleanups.push(
        editor.store.listen(
          ({ changes }) => {
            for (const [, to] of Object.values(changes.updated)) {
              if (to.typeName === "shape") void reader.moveNode(nodeIdOf(to.id), Math.round(to.x), Math.round(to.y)).then(save);
            }
          },
          { source: "user", scope: "document" },
        ),
      );
      const saveCamera = debounce(() => void reader.saveView({ camera: cameraOf(editor), ...(openSourceRef.current ? { openSourceId: openSourceRef.current } : {}) }), 500);
      let lastSel = "";
      cleanups.push(
        editor.store.listen(
          () => {
            saveCamera();
            const ids = editor.getSelectedShapeIds();
            const key = ids.join(",");
            if (key === lastSel) return;
            lastSel = key;
            if (ids.length !== 1) return;
            const node = nodesRef.current.find((n) => n.id === nodeIdOf(ids[0]!));
            if (node?.meta.anchor) setOpenSourceId(node.meta.anchor.sourceId);
          },
          { scope: "session" },
        ),
      );
    })();
    return () => {
      disposed = true;
      cleanups.forEach((c) => c());
    };
  }, [editor, reader, save]);

  const openSourceRef = useRef<string | null>(null);
  openSourceRef.current = openSourceId;

  // 阅读器：读文件 → 解析 → 加载图片
  useEffect(() => {
    if (!openSourceId) return;
    let dispose: (() => void) | undefined;
    let alive = true;
    void (async () => {
      const src = await reader.readSource(openSourceId);
      if (!src || !alive) return;
      const doc = await markdownAdapter.parse(openSourceId, src.text);
      const assets = await loadChapterAssets(reader.vault, src.path, doc);
      if (!alive) return assets.dispose();
      dispose = assets.dispose;
      setChapter({ doc, path: src.path, resolveAsset: assets.resolveAsset });
      setSelection(null);
      void reader.saveView({ ...(editor ? { camera: cameraOf(editor) } : {}), openSourceId });
    })();
    return () => {
      alive = false;
      dispose?.();
    };
  }, [openSourceId, reader, editor]);

  const runAction = useCallback(
    async (actionId: string) => {
      if (!chapter || !selection || !editor) return;
      const action = reader.registry.get("action", actionId);
      const anchor = markdownAdapter.selectionToAnchor(chapter.doc, { kind: "text", ...selection });
      const nodes = await reader.listNodes();
      const chapterNode = nodes.find((n) => n.meta.type === "chapter" && n.meta.anchor?.sourceId === chapter.doc.sourceId);
      const siblings = nodes.filter((n) => n.meta.type !== "chapter" && n.meta.anchor?.sourceId === chapter.doc.sourceId);
      const x = chapterNode?.x ?? 0;
      const y = (chapterNode?.y ?? 0) + STACK.top + siblings.length * STACK.step;
      // 第 5 步接入 AI 之前：「批注」生成批注卡，其余动作先生成摘录卡占位。
      const node = await reader.createNode(
        action?.usesLLM
          ? { type: "excerpt", x, y, width: 320, height: 120, anchor, text: `${action.name}：${anchor.quote.exact}` }
          : { type: "note", x, y, width: 240, height: 120, anchor, text: anchor.quote.exact, body: "" },
      );
      nodesRef.current = await reader.listNodes();
      syncShapes(editor, nodesRef.current);
      editor.select(shapeIdOf(node.id));
      setSelection(null);
      window.getSelection()?.removeAllRanges();
      save();
    },
    [chapter, selection, editor, reader, save],
  );

  return (
    <div className="layout">
      <nav className="rail" aria-label="目录">
        <button className="rail-item rail-home" title="关闭这本书" onClick={onClose}>
          ←
        </button>
        <ol className="rail-list">
          {book.sources.map((s, i) => (
            <li key={s.id}>
              <button
                className="rail-item"
                aria-current={s.id === openSourceId ? "page" : undefined}
                title={s.title ?? s.path}
                onClick={() => setOpenSourceId(s.id)}
              >
                <span className="rail-num">{i + 1}</span>
                <span className="rail-label">{s.title ?? s.path}</span>
              </button>
            </li>
          ))}
        </ol>
      </nav>
      <main className="canvas">
        <Tldraw onMount={setEditor} />
        <div className="canvas-status" data-rc="toolbar">
          {session.name}
          {!session.persistent && " · 示例书，改动不保存"}
          {saveError && <span className="canvas-error"> · 保存失败：{saveError}</span>}
        </div>
      </main>
      <aside className="reader" data-rc="reader">
        {selection && (
          <div className="popover" data-rc="popover" role="toolbar">
            {actions.map((a) => (
              <button key={a.id} onClick={() => void runAction(a.id)}>
                {a.name}
              </button>
            ))}
          </div>
        )}
        {chapter ? (
          <SourceReader doc={chapter.doc} resolveAsset={chapter.resolveAsset} onSelect={setSelection} />
        ) : (
          <p className="reader-empty">加载中…</p>
        )}
      </aside>
    </div>
  );
}
