/**
 * 阅读器里的多层批注标记（设计文档「阅读器里怎么画」、设计系统 ReaderMarks）：
 * 画布上的摘录卡 / 批注卡 → 定位到当前原文 → 句子背景、短语下划线、生词点线切进渲染好的 HAST；段落边沟另画一层。
 * 算法（切区间、命中顺序）在 @reader/core，这里只管把它接到节点和 DOM 上。
 */
import { type AnnotationMark, type MarkSegment, NODE_GROUP, type ReaderEdge, type ReaderNode, type SourceDoc } from "@reader/core";
import { blockRange, markdownAdapter } from "@reader/source-markdown";

/** 会在原文里画标记的节点：摘录（AI 动作的起点）和批注。 */
const ANNOTATION_TYPES = new Set(["excerpt", "note"]);

const clip = (s: string, n = 20) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

/**
 * 这一章上的批注标记。锚点按三层定位到当前原文，失效的不画（卡片上有「锚点失效」徽章）。
 * 列表文字：批注取自己写的话；摘录取它派生出的提问 / 回答标题，没有就取原文。
 */
export function annotationMarksFor(doc: SourceDoc, nodes: readonly ReaderNode[], edges: readonly ReaderEdge[]): AnnotationMark[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out: AnnotationMark[] = [];
  for (const n of nodes) {
    const a = n.meta.anchor;
    if (!ANNOTATION_TYPES.has(n.meta.type) || a?.kind !== "markdown" || a.sourceId !== doc.sourceId) continue;
    const loc = markdownAdapter.resolve(doc, a);
    if (!loc || loc.end <= loc.start) continue;
    const block = blockRange(doc, loc.start) ?? { start: loc.start, end: loc.end };
    let label = a.quote.exact;
    if (n.meta.type === "note" && n.text && n.text !== a.quote.exact) label = n.text;
    else {
      const child = edges.filter((e) => e.from === n.id).map((e) => byId.get(e.to)).find((c) => c && (c.label || c.text));
      if (child) label = child.meta.type === "operation" ? (child.text ?? child.label ?? label) : (child.label ?? label);
    }
    const group = NODE_GROUP[n.meta.type] === "user" ? "user" : "ai";
    const mark: AnnotationMark = { id: n.id, sourceId: doc.sourceId, start: loc.start, end: loc.end, granularity: a.granularity, group, label: clip(label), block };
    if (n.meta.createdAt) mark.createdAt = n.meta.createdAt;
    out.push(mark);
  }
  return out;
}

/* ---------- HAST：只用到的那一点结构，不引 hast 类型包 ---------- */

interface HText {
  type: "text";
  value: string;
}
interface HElement {
  type: "element";
  tagName: string;
  properties: Record<string, unknown>;
  children: HNode[];
}
type HNode = HText | HElement | { type: string; children?: HNode[] };
interface HRoot {
  type: "root";
  children: HNode[];
}

const isTextSpan = (n: HNode): n is HElement =>
  n.type === "element" && typeof (n as HElement).properties?.dataS === "number" && typeof (n as HElement).properties?.dataE === "number";

/** 一段文字套上它的装饰：句子背景在外，短语 / 生词下划线在里，最里面仍是带源偏移的文字 span。 */
function wrap(textSpan: HElement, seg: MarkSegment | undefined): HElement {
  let node = textSpan;
  if (!seg) return node;
  if (seg.phrase)
    node = el("span", { className: ["rc-mark-phrase"], dataRc: "mark", dataKind: "phrase", dataGroup: seg.phrase.group, dataOverlap: String(seg.phrase.overlap) }, [node]);
  else if (seg.vocab) node = el("span", { className: ["rc-mark-vocab"], dataRc: "mark", dataKind: "vocab", title: `生词本：${seg.vocab}` }, [node]);
  if (seg.sentence) node = el("span", { className: ["rc-mark-sent"], dataRc: "mark", dataKind: "sentence", dataGroup: seg.sentence.group, dataLevel: String(seg.sentence.level) }, [node]);
  return node;
}

const el = (tagName: string, properties: Record<string, unknown>, children: HNode[]): HElement => ({ type: "element", tagName, properties, children });

/**
 * 把装饰区间切进 HAST（返回新树，不改原树）。文字 span 在区间边界处一分为二，每一片仍带自己的 data-s / data-e，
 * 选区换算不受影响。文字长度和源偏移对不上的 span（转义、实体）不切，整段按开头所在区间装饰。
 */
export function decorateHast<T extends HRoot>(root: T, segments: readonly MarkSegment[]): T {
  if (!segments.length) return root;
  const segAt = (o: number) => segments.find((s) => s.start <= o && o < s.end);
  const visit = (children: HNode[]): HNode[] =>
    children.flatMap((c) => {
      if (isTextSpan(c)) {
        const s = c.properties.dataS as number;
        const e = c.properties.dataE as number;
        const text = c.children.length === 1 && c.children[0]!.type === "text" ? (c.children[0] as HText).value : null;
        if (!segments.some((g) => g.start < e && g.end > s)) return [c];
        if (text === null || text.length !== e - s) return [wrap(c, segAt(s))];
        const cuts = [s, ...segments.flatMap((g) => [g.start, g.end]).filter((x) => x > s && x < e), e];
        const uniq = [...new Set(cuts)].sort((a, b) => a - b);
        const out: HNode[] = [];
        for (let i = 0; i + 1 < uniq.length; i++) {
          const a = uniq[i]!;
          const b = uniq[i + 1]!;
          const piece = el(c.tagName, { ...c.properties, dataS: a, dataE: b }, [{ type: "text", value: text.slice(a - s, b - s) }]);
          out.push(wrap(piece, segAt(a)));
        }
        return out;
      }
      if (c.type === "element") return [{ ...(c as HElement), children: visit((c as HElement).children) }];
      return [c];
    });
  return { ...root, children: visit(root.children) };
}
