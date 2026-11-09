import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type Editor, Tldraw } from "tldraw";
import {
  type ActionTemplate,
  type Anchor,
  type AnswerDepth,
  type ReaderEdge,
  type ReaderNode,
  type SourceDoc,
  type AssembledContext,
  type ContextExcerpt,
  type Citation,
  type StatEvent,
  type SearchEntry,
  type SearchHit,
  type AnnotationMark,
  type GutterMark,
  annotationsAt,
  gutterMarks,
  markSegments,
  paragraphEntries,
  buildRunRecord,
  answerOutput,
  assembleContext,
  newId,
} from "@reader/core";
import { AnswerAccumulator } from "./answer-stream";
import { type ContextBase, contextBaseFor } from "./context-input";
import { markdownAdapter } from "@reader/source-markdown";
import { loadChapterAssets } from "./assets";
import { CARD_SIZE, cardPropsOf, edgeIdOf, edgeShapeId, nodeIdOf, shapeIdOf, syncShapes } from "./canvas-sync";
import { CARD_TYPE, CardShapeUtil } from "./card-shape";
import { EdgeShapeUtil } from "./edge-shape";
import { seedDemoCards } from "./demo-cards";
import { Icon } from "./icons";
import { aiReadiness, llmErrorText } from "./llm";
import type { BookSession } from "./session";
import { SourceReader, type TextRange } from "./SourceReader";
import { InlineCard, type InlineCardState } from "./InlineCard";
import { ContextPanel } from "./ContextPanel";
import { SearchPalette } from "./SearchPalette";
import { AnnotationStack } from "./AnnotationStack";
import { annotationMarksFor } from "./reader-marks";
import type { MarkPoint } from "./SourceReader";
import { type Direction, chapterCluster, focusSet, offscreenDirection } from "./attention";
import { focusAtom } from "./focus";
import { EDGE_TYPE } from "./edge-shape";

/** 新卡放在来源（章节卡）这一列最下面一张卡的下方。 */
const STACK_GAP = 40;
const SHAPE_UTILS = [CardShapeUtil, EdgeShapeUtil];

/** 一次生成的请求：上下文输入 + 校验引用用的原文 + 回答深度 + 用户在「本次上下文」里去掉的项。 */
interface GenRequest {
  base: ContextBase;
  sources: string[];
  depth: AnswerDepth;
  exclude: string[];
}

/** 回答卡的生成请求（重试、去掉某项重跑用）。 */
interface AnswerRequest extends GenRequest {
  actionId: string;
}

/** 就地卡的请求：钉到画布、重试、换深度要用。 */
interface InlineRequest extends GenRequest {
  action: ActionTemplate;
  anchor: Anchor;
}

const INTERRUPTED = "已中断";

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
  // 开发期给浏览器测试脚本用：window.__glossaEditor。
  if (import.meta.env.DEV && editor) (window as unknown as { __glossaEditor?: Editor }).__glossaEditor = editor;
  const [openSourceId, setOpenSourceId] = useState<string | null>(null);
  const [chapter, setChapter] = useState<{ doc: SourceDoc; path: string; resolveAsset: (s: string) => string | null } | null>(null);
  const [selection, setSelection] = useState<TextRange | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const actions = useMemo(() => reader.registry.list("action"), [reader]);
  const nodesRef = useRef<ReaderNode[]>([]);
  const [toast, setToast] = useState<{ text: string; detail: string } | null>(null);
  const [inline, setInline] = useState<InlineCardState | null>(null);
  /** 就地卡的请求：钉到画布、重试要用。 */
  const inlineReq = useRef<InlineRequest | null>(null);
  const inlineRun = useRef<string | null>(null);
  /** 正在流式生成的回答：回答卡 nodeId → runId。删卡或离开这本书时取消。 */
  const runsRef = useRef(new Map<string, string>());
  /** 回答卡的请求，「重试」用同一请求重新生成（只在本次会话内；重新打开书后从来源摘录卡推回）。 */
  const requestsRef = useRef(new Map<string, AnswerRequest>());
  /** 每张回答卡最近一次的「本次上下文」。 */
  const contextsRef = useRef(new Map<string, AssembledContext>());
  /** 打开着的「本次上下文」面板：某张回答卡的，或就地卡的。 */
  const [ctxPanel, setCtxPanel] = useState<{ kind: "answer"; nodeId: string; context: AssembledContext } | { kind: "inline" } | null>(null);
  const mountedRef = useRef(true);
  /** 跟随阅读（默认开，存在 view.json）。 */
  const [follow, setFollow] = useState(true);
  /** 视口外新卡提示。 */
  const [newCard, setNewCard] = useState<{ nodeId: string; dir: Direction } | null>(null);
  /** 画布内容的版本号：变了就重算阅读器里的批注标记。 */
  const [canvasRev, setCanvasRev] = useState(0);
  const newCardRef = useRef<string | null>(null);
  /** Cmd+K 搜索：打开时现收集条目（原文段落 + 卡片）。 */
  const [palette, setPalette] = useState<SearchEntry[] | null>(null);
  /** 记一条使用统计（stats.jsonl，不上传）。失败只在控制台提示。 */
  const stat = useCallback(
    (e: StatEvent) => void reader.journal.recordStat(e).catch((err: unknown) => console.warn("统计写入失败", err)),
    [reader],
  );
  const statRef = useRef(stat);
  statRef.current = stat;

  useEffect(() => {
    mountedRef.current = true;
    const runs = runsRef.current;
    return () => {
      mountedRef.current = false;
      for (const runId of runs.values()) void reader.llm.cancel(runId);
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

  /** 卡片增删排队同步到数据层，按发生顺序一条条做。 */
  const structure = useRef<Promise<void>>(Promise.resolve());
  const applyStructure = async (gone: { nodes: string[]; edges: string[] }, back: { nodes: string[]; edges: string[] }) => {
    if (!editor) return;
    let changed = false;
    if (gone.nodes.length) {
      // 删掉正在生成的回答卡：取消请求，不再花 token。
      for (const id of gone.nodes) {
        const runId = runsRef.current.get(id);
        if (runId) void reader.llm.cancel(runId);
      }
      const r = await reader.deleteNodes(gone.nodes);
      if (r.nodes.length) statRef.current({ event: "delete", count: r.nodes.length });
      changed ||= r.nodes.length > 0;
    }
    if (gone.edges.length) changed ||= (await reader.deleteEdges(gone.edges)).length > 0;
    if (back.nodes.length || back.edges.length) {
      const r = await reader.restore(back);
      // 生成到一半被撤销的回答：请求已取消，恢复后标成失败，可重试。
      for (const n of r.nodes) {
        if (n.meta.type !== "answer" || n.meta.status !== "running" || runsRef.current.has(n.id)) continue;
        const text = n.text ? `${n.text}\n\n（${INTERRUPTED}）` : INTERRUPTED;
        await reader.updateNode(n.id, { status: "failed", text, body: text });
      }
      changed ||= r.nodes.length + r.edges.length > 0;
    }
    if (!changed) return;
    nodesRef.current = await reader.listNodes();
    // 补连线 shape、删悬空连线、刷新恢复卡片的内容（撤销重做回来的 shape 可能是旧 props）。
    syncShapes(editor, nodesRef.current, await reader.listEdges(), book);
    save();
  };
  const applyStructureRef = useRef(applyStructure);
  applyStructureRef.current = applyStructure;

  // 画布：建 shape、恢复视口、监听拖动与选中
  useEffect(() => {
    if (!editor) return;
    let disposed = false;
    const cleanups: Array<() => void> = [];
    void (async () => {
      if (!session.persistent) await seedDemoCards(reader, book);
      // 上次流式生成到一半就关掉 / 刷新了：没有进行中的请求，标成失败，可重试。
      let interrupted = false;
      for (const n of await reader.listNodes()) {
        // 示例书在内存里、演示卡本来就是「进行中」，不处理。
        if (!session.persistent) break;
        if (n.meta.type !== "answer" || n.meta.status !== "running" || runsRef.current.has(n.id)) continue;
        const text = n.text ? `${n.text}\n\n（${INTERRUPTED}）` : INTERRUPTED;
        await reader.updateNode(n.id, { status: "failed", text, body: text });
        interrupted = true;
      }
      if (interrupted) save();
      nodesRef.current = await reader.listNodes();
      const edges = await reader.listEdges();
      if (disposed) return;
      // 打开时建的卡不进撤销栈：一按 Cmd+Z 不能把整张画布清空。
      editor.run(() => syncShapes(editor, nodesRef.current, edges, book), { history: "ignore" });
      editor.clearHistory();
      const view = await reader.getView();
      if (view?.followReading === false) setFollow(false);
      if (view?.camera) editor.setCamera(view.camera);
      else requestAnimationFrame(() => editor.zoomToFit({ animation: { duration: 0 } }));

      cleanups.push(
        editor.store.listen(
          ({ changes }) => {
            // 删卡（Delete 键、撤销新建）与恢复卡（撤销删除、重做新建）同步到数据层。
            const gone = { nodes: [] as string[], edges: [] as string[] };
            const back = { nodes: [] as string[], edges: [] as string[] };
            for (const rec of Object.values(changes.removed)) {
              if (rec.typeName !== "shape") continue;
              if (rec.type === CARD_TYPE) gone.nodes.push(nodeIdOf(rec.id));
              else if (rec.type === EDGE_TYPE) gone.edges.push(edgeIdOf(rec.id));
            }
            for (const rec of Object.values(changes.added)) {
              if (rec.typeName !== "shape") continue;
              if (rec.type === CARD_TYPE) back.nodes.push(nodeIdOf(rec.id));
              else if (rec.type === EDGE_TYPE) back.edges.push(edgeIdOf(rec.id));
            }
            if (gone.nodes.length || gone.edges.length || back.nodes.length || back.edges.length)
              structure.current = structure.current.then(() => applyStructureRef.current(gone, back)).catch((e: Error) => setSaveError(e.message));
            for (const [from, to] of Object.values(changes.updated)) {
              // 只处理位置变化：流式写回答时程序改的是 props，不能把卡标成 pinned，也不该每帧存盘。
              if (to.typeName !== "shape" || from.typeName !== "shape" || (from.x === to.x && from.y === to.y)) continue;
              void reader.moveNode(nodeIdOf(to.id), Math.round(to.x), Math.round(to.y)).then(save);
            }
          },
          { source: "user", scope: "document" },
        ),
      );
      // 卡片增删改（含流式写回答、撤销重做）→ 重算阅读器里的批注标记，一帧最多一次。
      let marksRaf = 0;
      cleanups.push(
        editor.store.listen(
          () => {
            cancelAnimationFrame(marksRaf);
            marksRaf = requestAnimationFrame(() => setCanvasRev((r) => r + 1));
          },
          { scope: "document" },
        ),
        () => cancelAnimationFrame(marksRaf),
      );
      cameraReady.current = true;
      const saveCamera = debounce(() => void reader.saveView({ camera: cameraOf(editor), ...(openSourceRef.current ? { openSourceId: openSourceRef.current } : {}) }), 500);
      let lastSel = "";
      let lastFar = editor.getZoomLevel() < 0.4;
      cleanups.push(
        editor.store.listen(
          () => {
            saveCamera();
            // 语义缩放跨过远近阈值时记一次统计。
            const far = editor.getZoomLevel() < 0.4;
            if (far !== lastFar) {
              lastFar = far;
              statRef.current({ event: "zoom", level: far ? "far" : "near" });
            }
            // 新卡进了视口，提示就收起。
            const pending = newCardRef.current;
            if (pending) {
              const b = editor.getShapePageBounds(shapeIdOf(pending));
              const v = editor.getViewportPageBounds();
              if (!b || !offscreenDirection({ x: v.x, y: v.y, w: v.w, h: v.h }, { x: b.x, y: b.y, w: b.w, h: b.h })) {
                newCardRef.current = null;
                setNewCard(null);
              }
            }
            const ids = editor.getSelectedShapeIds();
            const key = ids.join(",");
            if (key === lastSel) return;
            lastSel = key;
            // 聚焦模式：点中一张卡，只保留它的上下游。
            const card = ids.length === 1 ? editor.getShape(ids[0]!) : undefined;
            if (card?.type === CARD_TYPE) {
              const edges = editor
                .getCurrentPageShapes()
                .flatMap((s) => (s.type === EDGE_TYPE ? [{ id: s.id, ...(s.props as { from: string; to: string; role: ReaderEdge["role"] }) }] : []));
              const set = focusSet(nodeIdOf(card.id), edges);
              focusAtom.set(set);
              statRef.current({ event: "focus", size: set.size });
            } else focusAtom.set(null);
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
  const [locate, setLocate] = useState<{ nodeId?: string; range?: { sourceId: string; start: number; end: number }; seq: number } | null>(null);
  useEffect(() => {
    let seq = 0;
    const onLocate = (e: Event) => {
      const nodeId = (e as CustomEvent<{ nodeId: string }>).detail.nodeId;
      const node = nodesRef.current.find((n) => n.id === nodeId);
      if (!node?.meta.anchor) return;
      setOpenSourceId(node.meta.anchor.sourceId);
      setLocate({ nodeId, seq: ++seq });
      stat({ event: "locate", nodeId, sourceId: node.meta.anchor.sourceId });
    };
    window.addEventListener("glossa:locate", onLocate);
    return () => window.removeEventListener("glossa:locate", onLocate);
  }, [stat]);
  useEffect(() => {
    if (!locate || !chapter) return;
    let loc: { start: number; end: number } | null = null;
    if (locate.range) {
      if (locate.range.sourceId !== chapter.doc.sourceId) return;
      loc = locate.range;
    } else {
      const anchor = nodesRef.current.find((n) => n.id === locate.nodeId)?.meta.anchor;
      if (!anchor || anchor.sourceId !== chapter.doc.sourceId) return;
      loc = markdownAdapter.resolve(chapter.doc, anchor);
    }
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

  /** 改一张卡的显示（不重建所有 shape）。不进撤销栈：撤销跳过流式写入，直接撤掉整张卡。 */
  const refreshCard = useCallback(
    (n: ReaderNode | null) => {
      if (!n || !editor || !mountedRef.current) return;
      const i = nodesRef.current.findIndex((x) => x.id === n.id);
      if (i >= 0) nodesRef.current[i] = n;
      if (editor.getShape(shapeIdOf(n.id)))
        editor.run(() => editor.updateShape({ id: shapeIdOf(n.id), type: CARD_TYPE, props: cardPropsOf(n, book) }), { history: "ignore" });
    },
    [editor, book],
  );

  /** 打开搜索：每章原文切段落 + 画布上所有卡片的文字。 */
  const openPalette = useCallback(async () => {
    const entries: SearchEntry[] = [];
    for (const [i, src] of book.sources.entries()) {
      const s = await reader.readSource(src.id);
      if (s) entries.push(...paragraphEntries(src.id, src.title ?? `第 ${i + 1} 章`, s.text));
    }
    const TYPE: Record<string, string> = { chapter: "章节", excerpt: "摘录", operation: "提问", answer: "回答", note: "批注" };
    for (const n of await reader.listNodes()) {
      const text = [n.label, n.text, n.meta.anchor?.quote.exact].filter(Boolean).join("\n");
      if (text && n.meta.type !== "group") entries.push({ kind: "node", id: n.id, title: `${TYPE[n.meta.type] ?? "卡片"}${n.label ? ` · ${n.label}` : ""}`, text });
    }
    setPalette(entries);
  }, [book, reader]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        e.stopPropagation();
        void openPalette();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [openPalette]);

  /** 搜索结果跳转：原文 → 打开章节、滚动并闪烁；卡片 → 镜头移过去并选中。 */
  const pickHit = useCallback(
    (h: SearchHit) => {
      setPalette(null);
      if (h.entry.kind === "source") {
        const start = (h.entry.start ?? 0) + h.offset;
        setOpenSourceId(h.entry.id);
        setLocate({ range: { sourceId: h.entry.id, start, end: start + Math.max(1, h.mark[1] - h.mark[0]) }, seq: Date.now() });
      } else if (editor) {
        const b = editor.getShapePageBounds(shapeIdOf(h.entry.id));
        if (b) editor.centerOnPoint({ x: b.x + b.w / 2, y: b.y + b.h / 2 }, cameraAnim());
        editor.select(shapeIdOf(h.entry.id));
      }
      stat({ event: "search", kind: h.entry.kind });
    },
    [editor, stat],
  );

  /** 镜头动画：≤ 200ms，系统要求减少动效时直接跳。 */
  const cameraAnim = () => ({ animation: { duration: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 200 } });

  /** 目录里点章节：打开它；跟随阅读开着时，镜头移到这一章的节点群（保持缩放）。 */
  const openChapter = useCallback(
    (sourceId: string) => {
      setOpenSourceId(sourceId);
      if (!follow || !editor) return;
      void reader.listEdges().then((edges) => {
        const r = chapterCluster(nodesRef.current, edges, sourceId);
        if (!r) return;
        const v = editor.getViewportPageBounds();
        editor.centerOnPoint({ x: r.x + r.w / 2, y: r.y + Math.min(r.h, v.h) / 2 }, cameraAnim());
        stat({ event: "follow", on: true, auto: true });
      });
    },
    [follow, editor, reader, stat],
  );

  /** 新卡在视口外时在画布边缘提示，不自动移镜头（不打断阅读）。 */
  const noticeNewCard = useCallback(
    (nodeId: string) => {
      if (!editor) return;
      const b = editor.getShapePageBounds(shapeIdOf(nodeId));
      const v = editor.getViewportPageBounds();
      const dir = b && offscreenDirection({ x: v.x, y: v.y, w: v.w, h: v.h }, { x: b.x, y: b.y, w: b.w, h: b.h });
      newCardRef.current = dir ? nodeId : null;
      setNewCard(dir ? { nodeId, dir } : null);
    },
    [editor],
  );

  /** 点新卡提示：镜头移过去并选中它。 */
  const goToCard = useCallback(
    (nodeId: string) => {
      if (!editor) return;
      const b = editor.getShapePageBounds(shapeIdOf(nodeId));
      if (b) editor.centerOnPoint({ x: b.x + b.w / 2, y: b.y + b.h / 2 }, cameraAnim());
      editor.select(shapeIdOf(nodeId));
      if (newCard) stat({ event: "new-card-hint", dir: newCard.dir });
      newCardRef.current = null;
      setNewCard(null);
    },
    [editor, newCard, stat],
  );

  // 阅读器里的多层批注：这一章上的摘录卡和批注卡 → 句子背景、短语下划线、段落边沟。
  const marks = useMemo<AnnotationMark[]>(() => {
    if (!chapter || !editor) return [];
    const edges = editor
      .getCurrentPageShapes()
      .flatMap((s) => (s.type === EDGE_TYPE ? [{ id: s.id, ...(s.props as { from: string; to: string; role: ReaderEdge["role"] }) }] : []));
    return annotationMarksFor(chapter.doc, nodesRef.current, edges);
    // canvasRev：nodesRef 是 ref，靠它触发重算。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chapter, editor, canvasRev]);
  const segments = useMemo(() => markSegments(marks), [marks]);
  const gutters = useMemo(() => gutterMarks(marks), [marks]);

  /** 叠层浮层：悬停命中两层以上时出现；点边沟角标时列出本段全部批注（带键盘焦点）。 */
  const [stack, setStack] = useState<{ items: AnnotationMark[]; at: { left: number; bottom: number }; focus: boolean; hint?: string } | null>(null);
  const stackHover = useRef({ timer: 0 as ReturnType<typeof setTimeout> | 0, inside: false, pinned: false });
  const lastClick = useRef<{ key: string; i: number } | null>(null);
  useEffect(() => setStack(null), [chapter]);

  const onMarkHover = useCallback(
    (p: MarkPoint | null) => {
      const h = stackHover.current;
      if (h.pinned) return;
      clearTimeout(h.timer);
      h.timer = setTimeout(
        () => {
          if (!p) return void (!h.inside && setStack(null));
          const items = annotationsAt(marks, p.offset);
          if (items.length < 2) return void (!h.inside && setStack(null));
          setStack({ items, at: { left: p.rect.left, bottom: p.rect.bottom }, focus: false, hint: "单击打开最窄的一层，再点一次切到下一层" });
          stat({ event: "annotation", via: "hover", layers: items.length });
        },
        p ? 300 : 200,
      );
    },
    [marks, stat],
  );

  /** 单击批注标记：默认打开最窄的那层；在同一处再点一次，循环到下一层。 */
  const onMarkClick = useCallback(
    (p: MarkPoint) => {
      const items = annotationsAt(marks, p.offset);
      if (!items.length) return;
      const key = items.map((m) => m.id).join(",");
      const i = lastClick.current?.key === key ? (lastClick.current.i + 1) % items.length : 0;
      lastClick.current = { key, i };
      goToCard(items[i]!.id);
      stat({ event: "annotation", via: "click", layers: items.length });
    },
    [marks, goToCard, stat],
  );

  const onGutter = useCallback(
    (g: GutterMark, rect: MarkPoint["rect"]) => {
      const byId = new Map(marks.map((m) => [m.id, m]));
      const items = g.ids.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
      stackHover.current.pinned = true;
      setStack({ items, at: { left: rect.left, bottom: rect.bottom }, focus: true });
      stat({ event: "annotation", via: "gutter", layers: items.length });
    },
    [marks, stat],
  );

  const closeStack = useCallback(() => {
    stackHover.current.pinned = false;
    stackHover.current.inside = false;
    setStack(null);
  }, []);

  /** 组装本次上下文（第 6 步）：预算按动作的模型别名取。 */
  const assemble = useCallback(
    async (action: ActionTemplate, req: GenRequest): Promise<AssembledContext> =>
      assembleContext({ ...req.base, action, depth: req.depth, exclude: req.exclude, budget: await reader.llm.contextBudget(action.model) }),
    [reader],
  );

  /** 由锚点收集上下文输入：读来源 → 三层 + 周边段落；同一段的批注、之前的问答。 */
  const requestFor = useCallback(
    async (anchor: Anchor, ids: { excerptNodeId?: string; answerNodeId?: string }): Promise<Omit<GenRequest, "depth">> => {
      let doc = chapter?.doc.sourceId === anchor.sourceId ? chapter.doc : null;
      if (!doc) {
        const src = await reader.readSource(anchor.sourceId);
        if (src) doc = await markdownAdapter.parse(anchor.sourceId, src.text);
      }
      const extracted = doc ? markdownAdapter.extract(doc, anchor) : null;
      let part: Omit<ContextExcerpt, "nodeId"> = { selected: anchor.quote.exact, headingPath: anchor.kind === "markdown" ? anchor.headingPath : [] };
      if (extracted?.kind === "text") {
        const { kind: _kind, ...rest } = extracted;
        part = rest;
      }
      const base = contextBaseFor({ book, anchor, part, nodes: await reader.listNodes(), edges: await reader.listEdges(), ...ids });
      return { base, sources: [doc?.text ?? anchor.quote.exact], exclude: [] };
    },
    [reader, book, chapter],
  );

  /** 回答卡的请求：内存里有就用；重新打开书后从「摘录卡 → 回答卡」的 derived 边推回。 */
  const answerRequest = useCallback(
    async (answerId: string): Promise<AnswerRequest | null> => {
      const mem = requestsRef.current.get(answerId);
      if (mem) return mem;
      const edge = (await reader.listEdges()).find((x) => x.to === answerId && x.role === "derived");
      const from = edge && (await reader.listNodes()).find((n) => n.id === edge.from);
      const a = from?.meta.anchor;
      const answer = (await reader.listNodes()).find((n) => n.id === answerId);
      const action = reader.registry.list("action").find((x) => x.name === answer?.label) ?? reader.registry.get("action", "explain");
      if (!a || !action) return null;
      const g = await requestFor(a, { excerptNodeId: from.id, answerNodeId: answerId });
      return { actionId: action.id, ...g, depth: answer?.meta.depth ?? action.depth };
    },
    [reader, requestFor],
  );

  /** 写运行记录（runs/*.jsonl）和首字时间统计。记录失败不影响阅读，只在控制台提示。 */
  const logRun = useCallback(
    async (o: {
      acc: AnswerAccumulator;
      runId: string;
      nodeId?: string;
      action: ActionTemplate;
      depth: AnswerDepth;
      placement: "canvas" | "inline";
      ctx: AssembledContext;
      citations: Citation[];
      ok: boolean;
    }) => {
      const m = o.acc.meta;
      try {
        const ps = await reader.llm.providerSettings();
        const pricing = m.modelId ? ps?.capabilities?.[m.modelId]?.pricing : undefined;
        await reader.journal.recordRun(
          buildRunRecord({
            runId: o.runId,
            ...(o.nodeId ? { nodeId: o.nodeId } : {}),
            actionId: o.action.id,
            actionPrompt: o.action.prompt,
            depth: o.depth,
            placement: o.placement,
            providerId: m.providerId ?? "",
            alias: m.alias ?? o.action.model,
            modelId: m.modelId ?? "",
            context: o.ctx,
            output: o.acc.output,
            structured: o.acc.structured,
            ok: o.ok,
            ...(m.error ? { error: m.error } : {}),
            ...(m.finishReason ? { finishReason: m.finishReason } : {}),
            ...(m.usage ? { usage: m.usage } : {}),
            ...(m.firstChunkMs !== undefined ? { firstChunkMs: m.firstChunkMs } : {}),
            ...(m.durationMs !== undefined ? { durationMs: m.durationMs } : {}),
            ...(pricing ? { pricing } : {}),
            citations: o.citations,
          }),
        );
        if (o.ok && m.firstVisibleMs !== undefined) await reader.journal.recordStat({ event: "first-token", actionId: o.action.id, ms: m.firstVisibleMs });
      } catch (e) {
        console.warn("运行记录写入失败", e);
      }
    },
    [reader],
  );

  /** 流式写回答卡：文字增量每帧最多更新一次卡片，结束时存一次盘。 */
  const streamAnswer = useCallback(
    async (answerId: string, action: ActionTemplate, req: GenRequest) => {
      const { sources, depth } = req;
      const runId = newId();
      runsRef.current.set(answerId, runId);
      requestsRef.current.set(answerId, { actionId: action.id, ...req });
      const acc = new AnswerAccumulator(depth);
      const ctx = await assemble(action, req);
      contextsRef.current.set(answerId, ctx);
      let raf = 0;
      const flush = () => {
        raf = 0;
        void reader.updateNode(answerId, { text: acc.display() }).then(refreshCard);
      };
      const end = async (status: "done" | "failed", error?: string) => {
        if (raf) cancelAnimationFrame(raf);
        raf = 0;
        // 引用校验：citations 字段和正文里「」括起来的原话，逐条到原文里找。
        const { text: answer, citations } = acc.finish(sources);
        const text = error ? (answer ? `${answer}\n\n（中断：${error}）` : error) : answer;
        refreshCard(await reader.updateNode(answerId, { text, status, body: text, depth, citations }));
        save();
        void logRun({ acc, runId, nodeId: answerId, action, depth, placement: "canvas", ctx, citations, ok: status === "done" });
      };
      try {
        for await (const c of reader.llm.run({
          alias: action.model,
          runId,
          nodeId: answerId,
          actionId: action.id,
          instructions: ctx.instructions,
          messages: [{ role: "user", content: [{ type: "text", text: ctx.message }] }],
          output: answerOutput(depth),
        })) {
          if (acc.push(c)) {
            if (!raf) raf = requestAnimationFrame(flush);
          } else if (c.type === "finish") {
            await end("done");
          } else if (c.type === "error") {
            await end("failed", llmErrorText(c.error));
          }
        }
      } finally {
        if (runsRef.current.get(answerId) === runId) runsRef.current.delete(answerId);
      }
    },
    [reader, refreshCard, save, assemble, logRun],
  );

  // 失败回答卡上的「重试」：用同一请求重新生成。
  useEffect(() => {
    const onRetry = (e: Event) => {
      const answerId = (e as CustomEvent<{ nodeId: string }>).detail.nodeId;
      if (runsRef.current.has(answerId)) return;
      void (async () => {
        const req = await answerRequest(answerId);
        if (!req) return;
        const action = reader.registry.get("action", req.actionId);
        if (!action) return;
        refreshCard(await reader.updateNode(answerId, { status: "running", text: "" }));
        void streamAnswer(answerId, action, req);
      })();
    };
    window.addEventListener("glossa:retry", onRetry);
    return () => window.removeEventListener("glossa:retry", onRetry);
  }, [reader, refreshCard, streamAnswer, answerRequest]);

  // 回答卡上的「本次上下文」：打开面板。
  useEffect(() => {
    const onContext = (e: Event) => {
      const nodeId = (e as CustomEvent<{ nodeId: string }>).detail.nodeId;
      void (async () => {
        let context = contextsRef.current.get(nodeId);
        if (!context) {
          const req = await answerRequest(nodeId);
          const action = req && reader.registry.get("action", req.actionId);
          if (!req || !action) return;
          context = await assemble(action, req);
        }
        setCtxPanel({ kind: "answer", nodeId, context });
        stat({ event: "context", action: "open", excluded: context.items.filter((i) => i.excluded).length });
      })();
    };
    window.addEventListener("glossa:context", onContext);
    return () => window.removeEventListener("glossa:context", onContext);
  }, [reader, answerRequest, assemble, stat]);

  /** 去掉某几项后重新生成这张回答卡。 */
  const rerunAnswer = useCallback(
    async (answerId: string, exclude: string[]) => {
      if (runsRef.current.has(answerId)) return;
      const req = await answerRequest(answerId);
      const action = req && reader.registry.get("action", req.actionId);
      if (!req || !action) return;
      refreshCard(await reader.updateNode(answerId, { status: "running", text: "" }));
      stat({ event: "context", action: "rerun", excluded: exclude.length });
      const run = streamAnswer(answerId, action, { ...req, exclude });
      // 面板跟着显示新的上下文
      setTimeout(() => {
        const context = contextsRef.current.get(answerId);
        if (context) setCtxPanel((p) => (p?.kind === "answer" && p.nodeId === answerId ? { ...p, context } : p));
      }, 0);
      await run;
    },
    [reader, answerRequest, refreshCard, streamAnswer, stat],
  );

  /** 就地卡：流式写进阅读器顶部的小卡，不建画布节点。同一时间只有一张，新的会取消旧的。 */
  const runInline = useCallback(
    (req: InlineRequest) => {
      const { action, anchor, sources, depth } = req;
      if (inlineRun.current) void reader.llm.cancel(inlineRun.current);
      const runId = newId();
      inlineRun.current = runId;
      inlineReq.current = req;
      setInline({ runId, actionId: action.id, actionName: action.name, quote: anchor.quote.exact, text: "", status: "running", depth, citations: [] });
      const mine = (c: InlineCardState | null) => c?.runId === runId;
      void (async () => {
        const acc = new AnswerAccumulator(depth);
        const ctx = await assemble(action, req);
        if (inlineRun.current !== runId) return;
        setInline((c) => (mine(c) ? { ...c!, context: ctx } : c));
        let raf = 0;
        const flush = () => {
          raf = 0;
          setInline((c) => (mine(c) ? { ...c!, text: acc.display() } : c));
        };
        for await (const c of reader.llm.run({
          alias: action.model,
          runId,
          actionId: action.id,
          instructions: ctx.instructions,
          messages: [{ role: "user", content: [{ type: "text", text: ctx.message }] }],
          output: answerOutput(depth),
        })) {
          if (acc.push(c)) {
            if (!raf) raf = requestAnimationFrame(flush);
          } else if (c.type === "finish" || c.type === "error") {
            if (raf) cancelAnimationFrame(raf);
            const done = c.type === "finish";
            if (inlineRun.current === runId) inlineRun.current = null;
            const result = acc.finish(sources);
            void logRun({ acc, runId, action, depth, placement: "inline", ctx, citations: result.citations, ok: done });
            setInline((cur) =>
              mine(cur)
                ? {
                    ...cur!,
                    text: result.text,
                    status: done ? "done" : "failed",
                    citations: result.citations,
                    ...(done ? {} : { error: llmErrorText(c.error) }),
                  }
                : cur,
            );
          }
        }
      })();
    },
    [reader, assemble, logRun],
  );

  const closeInline = useCallback(() => {
    if (inlineRun.current) void reader.llm.cancel(inlineRun.current);
    inlineRun.current = null;
    setInline(null);
    inlineReq.current = null;
  }, [reader]);

  // 离开这本书时停掉就地卡的生成。
  useEffect(
    () => () => {
      if (inlineRun.current) void reader.llm.cancel(inlineRun.current);
    },
    [reader],
  );

  /** 下一张卡的位置：来源章节这一列最下面一张卡的下方。 */
  const nextSlot = useCallback(
    async (sourceId: string) => {
      const nodes = await reader.listNodes();
      const chapterNode = nodes.find((n) => n.meta.type === "chapter" && n.meta.anchor?.sourceId === sourceId);
      const x = chapterNode?.x ?? 0;
      const column = nodes.filter((n) => n.meta.type !== "group" && n.x < x + (chapterNode?.width ?? 320) && n.x + n.width > x);
      const y = Math.max((chapterNode?.y ?? 0) + (chapterNode?.height ?? 120), ...column.map((n) => n.y + n.height)) + STACK_GAP;
      return { x, y };
    },
    [reader],
  );

  /** 钉到画布：把就地卡的结果变成摘录卡 + 回答卡（已完成）。 */
  const pinInline = useCallback(async () => {
    const req = inlineReq.current;
    if (!req || !inline || inline.status !== "done" || !editor) return;
    const { x, y } = await nextSlot(req.anchor.sourceId);
    // 一次动作建的卡合成一步撤销。
    editor.markHistoryStoppingPoint("pin");
    const e = CARD_SIZE.excerpt!;
    const a = CARD_SIZE.answer!;
    const excerpt = await reader.createNode({ type: "excerpt", x, y, width: e.w, height: e.h, anchor: req.anchor, text: req.anchor.quote.exact });
    const answer = await reader.createNode({
      type: "answer",
      x,
      y: y + e.h + STACK_GAP,
      width: a.w,
      height: a.h,
      createdBy: "ai",
      status: "done",
      text: inline.text,
      body: inline.text,
      label: req.action.name,
      depth: req.depth,
      citations: inline.citations,
    });
    await reader.connect(excerpt.id, answer.id, "derived");
    nodesRef.current = await reader.listNodes();
    syncShapes(editor, nodesRef.current, await reader.listEdges(), book);
    editor.select(shapeIdOf(answer.id));
    noticeNewCard(answer.id);
    save();
    stat({ event: "pin", actionId: req.action.id });
    closeInline();
  }, [inline, editor, reader, book, save, nextSlot, closeInline, stat, noticeNewCard]);

  const runAction = useCallback(
    async (actionId: string) => {
      if (!chapter || !selection || !editor) return;
      const action = reader.registry.get("action", actionId);
      // 调用 AI 的动作按模板流式生成：placement: inline 的弹就地卡，其余生成摘录卡 + 回答卡。
      const streams = Boolean(action?.usesLLM && action.prompt);
      if (streams) {
        const problem = await aiReadiness((await reader.llm.getSettings()).llm.activeProvider);
        if (problem) {
          setToast({ text: "未配置 AI", detail: problem });
          return;
        }
      }
      const anchor = markdownAdapter.selectionToAnchor(chapter.doc, { kind: "text", ...selection });
      if (streams && action && action.placement === "inline") {
        setSelection(null);
        window.getSelection()?.removeAllRanges();
        const g = await requestFor(anchor, {});
        stat({ event: "action", actionId: action.id, placement: "inline", followup: Boolean(g.base.conversation?.length) });
        runInline({ action, anchor, ...g, depth: action.depth });
        return;
      }
      editor.markHistoryStoppingPoint(`action:${actionId}`);
      const nodes = await reader.listNodes();
      const chapterNode = nodes.find((n) => n.meta.type === "chapter" && n.meta.anchor?.sourceId === chapter.doc.sourceId);
      const x = chapterNode?.x ?? 0;
      const column = nodes.filter((n) => n.meta.type !== "group" && n.x < x + (chapterNode?.width ?? 320) && n.x + n.width > x);
      const y = Math.max((chapterNode?.y ?? 0) + (chapterNode?.height ?? 120), ...column.map((n) => n.y + n.height)) + STACK_GAP;
      const size = action?.usesLLM ? CARD_SIZE.excerpt! : CARD_SIZE.note!;
      // 「批注」生成批注卡；AI 动作生成摘录卡 + 回答卡。
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
      noticeNewCard(answerId ?? node.id);
      setSelection(null);
      window.getSelection()?.removeAllRanges();
      save();
      if (answerId && action) {
        const g = await requestFor(anchor, { excerptNodeId: node.id, answerNodeId: answerId });
        stat({ event: "action", actionId: action.id, placement: "canvas", followup: Boolean(g.base.conversation?.length) });
        void streamAnswer(answerId, action, { ...g, depth: action.depth });
      }
    },
    [chapter, selection, editor, reader, save, book, streamAnswer, runInline, requestFor, stat, noticeNewCard],
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
                onClick={() => openChapter(s.id)}
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
        {stack && (
          <AnnotationStack
            items={stack.items}
            at={stack.at}
            focus={stack.focus}
            hint={stack.hint}
            onHover={(inside) => {
              stackHover.current.inside = inside;
              if (!inside && !stackHover.current.pinned) onMarkHover(null);
            }}
            onOpen={(m) => {
              closeStack();
              goToCard(m.id);
            }}
            onLocate={(m) => {
              closeStack();
              setLocate({ range: { sourceId: m.sourceId, start: m.start, end: m.end }, seq: Date.now() });
            }}
            onClose={closeStack}
          />
        )}
        {palette && <SearchPalette entries={palette} onPick={pickHit} onClose={() => setPalette(null)} />}
        {newCard && (
          <button className="new-card-hint" data-dir={newCard.dir} onClick={() => goToCard(newCard.nodeId)}>
            新卡片
            <Icon name="new-card" />
          </button>
        )}
        {ctxPanel?.kind === "answer" && (
          <ContextPanel
            title={nodesRef.current.find((n) => n.id === ctxPanel.nodeId)?.label ?? "回答"}
            context={ctxPanel.context}
            busy={runsRef.current.has(ctxPanel.nodeId)}
            onRerun={(exclude) => void rerunAnswer(ctxPanel.nodeId, exclude)}
            onClose={() => setCtxPanel(null)}
          />
        )}
        {ctxPanel?.kind === "inline" && inline?.context && (
          <ContextPanel
            title={`${inline.actionName} · ${inline.quote}`}
            context={inline.context}
            busy={inline.status === "running"}
            onRerun={(exclude) => {
              const r = inlineReq.current;
              if (!r) return;
              stat({ event: "context", action: "rerun", excluded: exclude.length });
              runInline({ ...r, exclude });
            }}
            onClose={() => setCtxPanel(null)}
          />
        )}
        <div className="canvas-status" data-rc="toolbar">
          {session.name}
          {!session.persistent && " · 示例书，改动不保存"}
          {saveError && <span className="canvas-error"> · 保存失败：{saveError}</span>}
          <button
            className="rc-iconbtn"
            aria-label="跟随阅读"
            aria-pressed={follow}
            title={follow ? "跟随阅读：开（换章时镜头移到这一章的卡片）" : "跟随阅读：关"}
            onClick={() => {
              const on = !follow;
              setFollow(on);
              void reader.saveView({ followReading: on });
              stat({ event: "follow", on });
            }}
          >
            <Icon name="follow" />
          </button>
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
        {inline && (
          <InlineCard
            card={inline}
            onPin={() => void pinInline()}
            onClose={closeInline}
            onRetry={() => {
              const r = inlineReq.current;
              if (r) runInline(r);
            }}
            onContext={() => {
              setCtxPanel({ kind: "inline" });
              stat({ event: "context", action: "open", excluded: inline.context?.items.filter((i) => i.excluded).length ?? 0 });
            }}
            onDepth={(depth) => {
              const r = inlineReq.current;
              if (!r || depth === r.depth) return;
              stat({ event: "depth", actionId: r.action.id, depth });
              runInline({ ...r, depth });
            }}
          />
        )}
        {chapter ? (
          <SourceReader
            doc={chapter.doc}
            resolveAsset={chapter.resolveAsset}
            onSelect={setSelection}
            segments={segments}
            gutters={gutters}
            onMarkHover={onMarkHover}
            onMarkClick={onMarkClick}
            onGutter={onGutter}
          />
        ) : (
          <p className="reader-empty">加载中…</p>
        )}
      </aside>
    </div>
  );
}
