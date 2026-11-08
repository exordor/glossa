import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type Editor, Tldraw } from "tldraw";
import { type ActionTemplate, type ReaderNode, type SourceDoc, newId } from "@reader/core";
import { markdownAdapter } from "@reader/source-markdown";
import { loadChapterAssets } from "./assets";
import { CARD_SIZE, cardPropsOf, nodeIdOf, shapeIdOf, syncShapes } from "./canvas-sync";
import { CARD_TYPE, CardShapeUtil } from "./card-shape";
import { EdgeShapeUtil } from "./edge-shape";
import { seedDemoCards } from "./demo-cards";
import { Icon } from "./icons";
import { aiReadiness, llmErrorText } from "./llm";
import type { BookSession } from "./session";
import { SourceReader, type TextRange } from "./SourceReader";

/** 新卡放在来源（章节卡）这一列最下面一张卡的下方。 */
const STACK_GAP = 40;
const SHAPE_UTILS = [CardShapeUtil, EdgeShapeUtil];

/** 第 4 步的临时提示词（模板、结构化输出、上下文组装是第 5、6 步）。 */
const STREAM_PROMPTS: Record<string, string> = {
  explain: "用中文解释下面这段文字，先给一句话结论，再展开。",
  ask: "下面是读者从书里选中的一段文字，把它当作读者的问题，用中文回答：先给一句话结论，再展开。",
};

/** 跳回原文：滚到锚点所在的文字并闪一下。 */
function flashRange(root: HTMLElement, start: number, end: number) {
  const spans = [...root.querySelectorAll<HTMLElement>("[data-s]")].filter(
    (sp) => Number(sp.dataset.e) > start && Number(sp.dataset.s) < end,
  );
  const first = spans[0];
  if (!first) return false;
  first.scrollIntoView({ block: "center", behavior: "smooth" });
  for (const sp of spans) {
    sp.classList.remove("rc-flash");
    void sp.offsetWidth; // 重新触发动画
    sp.classList.add("rc-flash");
  }
  return true;
}

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

export function BookView({ session, onClose, onOpenSettings }: { session: BookSession; onClose: () => void; onOpenSettings: () => void }) {
  const { reader, book } = session;
  const [editor, setEditor] = useState<Editor | null>(null);
  const [openSourceId, setOpenSourceId] = useState<string | null>(null);
  const [chapter, setChapter] = useState<{ doc: SourceDoc; path: string; resolveAsset: (s: string) => string | null } | null>(null);
  const [selection, setSelection] = useState<TextRange | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const actions = useMemo(() => reader.registry.list("action"), [reader]);
  const nodesRef = useRef<ReaderNode[]>([]);
  const [toast, setToast] = useState<{ text: string; detail: string } | null>(null);
  /** 正在流式生成的回答：runId 集合。离开这本书时全部取消。 */
  const runsRef = useRef(new Set<string>());
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    const runs = runsRef.current;
    return () => {
      mountedRef.current = false;
      for (const id of runs) void reader.llm.cancel(id);
    };
  }, [reader]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 8000);
    return () => clearTimeout(t);
  }, [toast]);

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
      if (!session.persistent) await seedDemoCards(reader, book);
      nodesRef.current = await reader.listNodes();
      const edges = await reader.listEdges();
      if (disposed) return;
      syncShapes(editor, nodesRef.current, edges, book);
      const view = await reader.getView();
      if (view?.camera) editor.setCamera(view.camera);
      else requestAnimationFrame(() => editor.zoomToFit({ animation: { duration: 0 } }));

      cleanups.push(
        editor.store.listen(
          ({ changes }) => {
            for (const [from, to] of Object.values(changes.updated)) {
              // 只处理位置变化：流式写回答时程序改的是 props，不能把卡标成 pinned，也不该每帧存盘。
              if (to.typeName !== "shape" || from.typeName !== "shape" || (from.x === to.x && from.y === to.y)) continue;
              void reader.moveNode(nodeIdOf(to.id), Math.round(to.x), Math.round(to.y)).then(save);
            }
          },
          { source: "user", scope: "document" },
        ),
      );
      cameraReady.current = true;
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
  }, [editor, reader, save, session.persistent, book]);

  const openSourceRef = useRef<string | null>(null);
  /** 视口恢复之前不保存视口，否则会把默认视口写进 view.json。 */
  const cameraReady = useRef(false);
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
      void reader.saveView({ ...(editor && cameraReady.current ? { camera: cameraOf(editor) } : {}), openSourceId });
    })();
    return () => {
      alive = false;
      dispose?.();
    };
  }, [openSourceId, reader, editor]);

  // 卡片上的「跳回原文」：打开对应章节，三层定位找到原文，滚过去闪一下。
  const [locate, setLocate] = useState<{ nodeId: string; seq: number } | null>(null);
  useEffect(() => {
    let seq = 0;
    const onLocate = (e: Event) => {
      const nodeId = (e as CustomEvent<{ nodeId: string }>).detail.nodeId;
      const node = nodesRef.current.find((n) => n.id === nodeId);
      if (!node?.meta.anchor) return;
      setOpenSourceId(node.meta.anchor.sourceId);
      setLocate({ nodeId, seq: ++seq });
    };
    window.addEventListener("glossa:locate", onLocate);
    return () => window.removeEventListener("glossa:locate", onLocate);
  }, []);
  useEffect(() => {
    if (!locate || !chapter) return;
    const anchor = nodesRef.current.find((n) => n.id === locate.nodeId)?.meta.anchor;
    if (!anchor || anchor.sourceId !== chapter.doc.sourceId) return;
    const loc = markdownAdapter.resolve(chapter.doc, anchor);
    if (!loc) {
      setLocate(null);
      return;
    }
    // 原文异步渲染，等文字 span 出现再滚动（最多约 2 秒）。
    let tries = 0;
    let raf = 0;
    const tick = () => {
      const root = document.querySelector<HTMLElement>(".reader-body");
      if (root && flashRange(root, loc.start, loc.end)) return setLocate(null);
      if (++tries < 120) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [locate, chapter]);

  /** 改一张卡的显示（不重建所有 shape）。 */
  const refreshCard = useCallback(
    (n: ReaderNode | null) => {
      if (!n || !editor || !mountedRef.current) return;
      const i = nodesRef.current.findIndex((x) => x.id === n.id);
      if (i >= 0) nodesRef.current[i] = n;
      if (editor.getShape(shapeIdOf(n.id))) editor.updateShape({ id: shapeIdOf(n.id), type: CARD_TYPE, props: cardPropsOf(n, book) });
    },
    [editor, book],
  );

  /** 流式写回答卡：文字增量每帧最多更新一次卡片，结束时存一次盘。 */
  const streamAnswer = useCallback(
    async (answerId: string, action: ActionTemplate, text: string, where: string[]) => {
      const runId = newId();
      runsRef.current.add(runId);
      let acc = "";
      let raf = 0;
      const flush = () => {
        raf = 0;
        void reader.updateNode(answerId, { text: acc }).then(refreshCard);
      };
      const end = async (patch: { text: string; status: "done" | "failed" }) => {
        if (raf) cancelAnimationFrame(raf);
        raf = 0;
        refreshCard(await reader.updateNode(answerId, { ...patch, body: patch.text }));
        save();
      };
      try {
        const source = where.length ? `\n\n（出自：${where.join(" › ")}）` : "";
        for await (const c of reader.llm.run({
          alias: action.model,
          runId,
          nodeId: answerId,
          actionId: action.id,
          instructions: STREAM_PROMPTS[action.id] ?? STREAM_PROMPTS.explain,
          messages: [{ role: "user", content: [{ type: "text", text: text + source }] }],
        })) {
          if (c.type === "text") {
            acc += c.delta;
            if (!raf) raf = requestAnimationFrame(flush);
          } else if (c.type === "finish") {
            await end({ text: acc, status: "done" });
          } else if (c.type === "error") {
            const msg = llmErrorText(c.error);
            await end({ text: acc ? `${acc}\n\n（中断：${msg}）` : msg, status: "failed" });
          }
        }
      } finally {
        runsRef.current.delete(runId);
      }
    },
    [reader, refreshCard, save],
  );

  const runAction = useCallback(
    async (actionId: string) => {
      if (!chapter || !selection || !editor) return;
      const action = reader.registry.get("action", actionId);
      // 第 4 步：「解释」「提问」流式生成回答卡；「词义」「拆句」仍是占位（第 5 步）。
      const streams = Boolean(action?.usesLLM && STREAM_PROMPTS[actionId]);
      if (streams) {
        const problem = await aiReadiness((await reader.llm.getSettings()).llm.activeProvider);
        if (problem) {
          setToast({ text: "未配置 AI", detail: problem });
          return;
        }
      }
      const anchor = markdownAdapter.selectionToAnchor(chapter.doc, { kind: "text", ...selection });
      const nodes = await reader.listNodes();
      const chapterNode = nodes.find((n) => n.meta.type === "chapter" && n.meta.anchor?.sourceId === chapter.doc.sourceId);
      const x = chapterNode?.x ?? 0;
      const column = nodes.filter((n) => n.meta.type !== "group" && n.x < x + (chapterNode?.width ?? 320) && n.x + n.width > x);
      const y = Math.max((chapterNode?.y ?? 0) + (chapterNode?.height ?? 120), ...column.map((n) => n.y + n.height)) + STACK_GAP;
      const size = action?.usesLLM ? CARD_SIZE.excerpt! : CARD_SIZE.note!;
      // 「批注」生成批注卡，其余 AI 动作先生成摘录卡；「解释」「提问」再接一张回答卡。
      const node = await reader.createNode(
        action?.usesLLM
          ? { type: "excerpt", x, y, width: size.w, height: size.h, anchor, text: anchor.quote.exact }
          : { type: "note", x, y, width: size.w, height: size.h, anchor, text: anchor.quote.exact, body: "" },
      );
      let answerId: string | null = null;
      if (streams) {
        const a = CARD_SIZE.answer!;
        const answer = await reader.createNode({
          type: "answer",
          x,
          y: y + size.h + STACK_GAP,
          width: a.w,
          height: a.h,
          createdBy: "ai",
          status: "running",
          text: "",
        });
        await reader.connect(node.id, answer.id, "derived");
        answerId = answer.id;
      }
      nodesRef.current = await reader.listNodes();
      syncShapes(editor, nodesRef.current, await reader.listEdges(), book);
      editor.select(shapeIdOf(answerId ?? node.id));
      setSelection(null);
      window.getSelection()?.removeAllRanges();
      save();
      if (answerId && action) {
        const where = anchor.kind === "markdown" ? anchor.headingPath : [];
        void streamAnswer(answerId, action, anchor.quote.exact, where);
      }
    },
    [chapter, selection, editor, reader, save, book, streamAnswer],
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
        <Tldraw shapeUtils={SHAPE_UTILS} onMount={setEditor} />
        <div className="canvas-status" data-rc="toolbar">
          {session.name}
          {!session.persistent && " · 示例书，改动不保存"}
          {saveError && <span className="canvas-error"> · 保存失败：{saveError}</span>}
          <button className="rc-iconbtn" aria-label="设置" title="设置" onClick={onOpenSettings}>
            <Icon name="settings" />
          </button>
        </div>
        {toast && (
          <div className="ai-toast" role="status">
            <span>
              {toast.text}
              <span className="ai-toast-detail"> · {toast.detail}</span>
            </span>
            <button
              className="btn btn-sm btn-primary"
              onClick={() => {
                setToast(null);
                onOpenSettings();
              }}
            >
              去设置
            </button>
            <button className="rc-iconbtn" aria-label="关闭提示" onClick={() => setToast(null)}>
              <Icon name="close" />
            </button>
          </div>
        )}
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
