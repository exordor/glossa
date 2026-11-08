/**
 * 画布同步：@reader/core 的节点和连线是数据，tldraw 的 shape 是它的显示。
 * upsert：新节点建 shape，已有的只更新显示内容（位置由用户拖动决定，不覆盖）。
 */
import { type Editor, type TLShapeId, createShapeId } from "tldraw";
import { NODE_GROUP, type Book, type ReaderEdge, type ReaderNode } from "@reader/core";
import { CARD_TYPE, type CardProps } from "./card-shape";
import { EDGE_TYPE } from "./edge-shape";

export const shapeIdOf = (nodeId: string): TLShapeId => createShapeId(nodeId);
export const nodeIdOf = (shapeId: string): string => shapeId.replace(/^shape:/, "");
const edgeShapeId = (edgeId: string): TLShapeId => createShapeId(`edge-${edgeId}`);

/** 每种卡的默认高度（宽度来自设计系统 size-card-*）。内容超出时卡内截断，全文去右侧面板读。 */
export const CARD_SIZE: Record<string, { w: number; h: number }> = {
  chapter: { w: 320, h: 88 },
  excerpt: { w: 320, h: 120 },
  operation: { w: 280, h: 96 },
  answer: { w: 360, h: 148 },
  note: { w: 240, h: 140 },
  group: { w: 400, h: 300 },
};

/** 句界：标点或换行（标题、段落之间不跨）。 */
const SENTENCE_END = /[.?!;。？！；\n]/;

/** 摘录卡显示所在整句、选中的部分加粗：从引文前后文里截到句界。 */
function quoteParts(q: { exact: string; prefix: string; suffix: string }) {
  let pre = q.prefix;
  const cut = Math.max(...[...pre].map((c, i) => (SENTENCE_END.test(c) ? i + 1 : -1)));
  if (cut > 0) pre = pre.slice(cut);
  // 前文是截断的（没碰到句界）：去掉半个词，前面补省略号。
  else if (pre) pre = "…" + pre.replace(/^\S*\s/, "");
  let post = q.suffix;
  const end = [...post].findIndex((c) => SENTENCE_END.test(c));
  if (end >= 0) post = post.slice(0, end + 1);
  else if (post) post = post.replace(/\s\S*$/, "") + "…";
  return { quotePre: pre.trimStart(), quoteHit: q.exact, quotePost: post.trimEnd() };
}

export function cardPropsOf(node: ReaderNode, book: Book): CardProps {
  const t = node.meta.type;
  const size = CARD_SIZE[t] ?? CARD_SIZE.note!;
  const a = node.meta.anchor;
  const source = a ? book.sources.find((s) => s.id === a.sourceId) : undefined;
  const chapterNo = source ? book.sources.indexOf(source) + 1 : 0;
  const path = a?.kind === "markdown" ? a.headingPath : [];
  const base: CardProps = {
    w: size.w,
    h: size.h,
    nodeId: node.id,
    nodeType: t,
    group: NODE_GROUP[t],
    state: node.meta.status,
    createdBy: node.meta.createdBy.startsWith("plugin:") ? "plugin" : node.meta.createdBy,
    crumb: "",
    title: "",
    quotePre: "",
    quoteHit: "",
    quotePost: "",
    body: "",
    hasAnchor: Boolean(a),
  };
  switch (t) {
    case "chapter":
      return { ...base, crumb: `第 ${chapterNo} 章 · ${source?.path ?? ""}`, title: node.text ?? "" };
    case "excerpt":
      return { ...base, crumb: path.slice(1).join(" › ") || path.join(" › "), ...(a ? quoteParts(a.quote) : {}) };
    case "operation":
      return { ...base, crumb: node.label ?? "提问", title: node.text ?? "" };
    case "answer":
      return { ...base, crumb: node.meta.version ? `回答 · 版本 ${node.meta.version}` : "回答", body: node.text ?? "" };
    case "note": {
      // 有锚点：显示原文句（选中部分加粗）+ 我的批注；批注为空或等于原文时只显示原文。
      const own = node.text && node.text !== a?.quote.exact ? node.text : "";
      return {
        ...base,
        crumb: a ? `我的批注 · ${path.at(-1) ?? ""}` : "我的批注",
        ...(a ? quoteParts(a.quote) : {}),
        body: a ? own : (node.text ?? ""),
      };
    }
    default:
      return { ...base, title: node.label ?? node.text ?? "" };
  }
}

export function syncShapes(editor: Editor, nodes: ReaderNode[], edges: ReaderEdge[], book: Book) {
  editor.run(() => {
    // 连线先建，排在卡片下面
    for (const e of edges) {
      const id = edgeShapeId(e.id);
      const props = { from: e.from, to: e.to, role: e.role, label: e.label ?? "" };
      if (!editor.getShape(id)) editor.createShape({ id, type: EDGE_TYPE, x: 0, y: 0, props });
    }
    for (const n of nodes) {
      if (n.meta.type === "group") continue;
      const id = shapeIdOf(n.id);
      const props = cardPropsOf(n, book);
      const existing = editor.getShape(id);
      if (!existing) editor.createShape({ id, type: CARD_TYPE, x: n.x, y: n.y, props });
      else if (JSON.stringify(existing.props) !== JSON.stringify(props)) editor.updateShape({ id, type: CARD_TYPE, props });
    }
    const edgeIds = edges.map((e) => edgeShapeId(e.id));
    if (edgeIds.length) editor.sendToBack(edgeIds);
  });
}
