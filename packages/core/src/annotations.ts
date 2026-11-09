/**
 * 多层批注的包含树（设计文档「多层批注」）。
 * 存储平铺、不存层级；层级在需要时由范围包含关系算出。算法确定，CLI / MCP / 界面结果一致：
 * 同一 Source 内按 start 升序、end 降序排，每个锚点的父节点 = 前面最近一个完全包含它的锚点。
 * 交叉而不包含的两个范围是兄弟。范围完全相同时当兄弟处理。
 */
import type { Granularity, NodeGroup } from "./types.js";
export interface RangeItem {
  id: string;
  sourceId: string;
  start: number;
  end: number;
  /** 范围完全相同时按创建时间排。 */
  createdAt?: string;
}

export function containmentParents(items: readonly RangeItem[]): Map<string, string | null> {
  const parents = new Map<string, string | null>();
  const bySource = new Map<string, RangeItem[]>();
  for (const it of items) {
    const list = bySource.get(it.sourceId) ?? [];
    list.push(it);
    bySource.set(it.sourceId, list);
  }
  for (const list of bySource.values()) {
    const sorted = [...list].sort(
      (a, b) =>
        a.start - b.start ||
        b.end - a.end ||
        (a.createdAt ?? "").localeCompare(b.createdAt ?? "") ||
        a.id.localeCompare(b.id),
    );
    for (let i = 0; i < sorted.length; i++) {
      const cur = sorted[i]!;
      let parent: string | null = null;
      for (let j = i - 1; j >= 0; j--) {
        const cand = sorted[j]!;
        const same = cand.start === cur.start && cand.end === cur.end;
        if (!same && cand.start <= cur.start && cand.end >= cur.end) {
          parent = cand.id;
          break;
        }
      }
      parents.set(cur.id, parent);
    }
  }
  return parents;
}

/* ---------- 阅读器里的显示通道（设计文档「阅读器里怎么画」） ---------- */


/** 一条已定位到当前原文的批注（锚点已经过三层定位，start/end 是现在的偏移）。 */
export interface AnnotationMark extends RangeItem {
  granularity: Granularity;
  /** 颜色按来源：AI 蓝、用户琥珀。 */
  group: Extract<NodeGroup, "ai" | "user">;
  /** 列表里显示的前 20 字。 */
  label: string;
  /** 所在块（段落）的范围；段落批注的显示范围就是它。 */
  block: { start: number; end: number };
}

/** 生词本命中：原文里出现了查过的词。 */
export interface VocabHit {
  start: number;
  end: number;
  word: string;
}

/** 原文的一段区间和它的装饰。区间之间不重叠，覆盖所有有装饰的文字。 */
export interface MarkSegment {
  start: number;
  end: number;
  /** 句子批注：淡色背景，同层重叠加深一级，最多两级。 */
  sentence?: { group: AnnotationMark["group"]; level: 1 | 2 };
  /** 短语 / 词批注：实线下划线，同层重叠变双线。 */
  phrase?: { group: AnnotationMark["group"]; overlap: boolean };
  /** 生词点状下划线：最低优先级，被短语批注覆盖时隐藏。 */
  vocab?: string;
}

/** 段落边沟：一段有批注就画色条 + 本段批注总数（超过 20 显示「20+」）。 */
export interface GutterMark {
  start: number;
  end: number;
  count: number;
  /** 色条颜色：有段落批注时取它的来源，否则取本段第一条批注的来源。 */
  group: AnnotationMark["group"];
  ids: string[];
}

const isInline = (m: AnnotationMark) => m.granularity !== "block";
const isPhrase = (m: AnnotationMark) => m.granularity === "phrase" || m.granularity === "word";
const byWidth = (a: AnnotationMark, b: AnnotationMark) =>
  a.end - a.start - (b.end - b.start) || (a.createdAt ?? "").localeCompare(b.createdAt ?? "") || a.id.localeCompare(b.id);

/** 把句子、短语批注和生词命中切成互不重叠的装饰区间。 */
export function markSegments(marks: readonly AnnotationMark[], vocab: readonly VocabHit[] = []): MarkSegment[] {
  const inline = marks.filter((m) => isInline(m) && m.end > m.start);
  const words = vocab.filter((v) => v.end > v.start);
  const cuts = [...new Set([...inline, ...words].flatMap((r) => [r.start, r.end]))].sort((a, b) => a - b);
  const out: MarkSegment[] = [];
  for (let i = 0; i + 1 < cuts.length; i++) {
    const start = cuts[i]!;
    const end = cuts[i + 1]!;
    const on = inline.filter((m) => m.start <= start && m.end >= end).sort(byWidth);
    const sent = on.filter((m) => m.granularity === "sentence");
    const phr = on.filter(isPhrase);
    const seg: MarkSegment = { start, end };
    if (sent.length) seg.sentence = { group: sent[0]!.group, level: sent.length > 1 ? 2 : 1 };
    if (phr.length) seg.phrase = { group: phr[0]!.group, overlap: phr.length > 1 };
    const w = !phr.length && words.find((v) => v.start <= start && v.end >= end);
    if (w) seg.vocab = w.word;
    if (seg.sentence || seg.phrase || seg.vocab) out.push(seg);
  }
  // 相邻且装饰相同的区间合并，少切几刀。
  const merged: MarkSegment[] = [];
  for (const s of out) {
    const prev = merged.at(-1);
    const { start: _s, end: _e, ...deco } = s;
    if (prev && prev.end === s.start) {
      const { start: _ps, end: _pe, ...prevDeco } = prev;
      if (JSON.stringify(prevDeco) === JSON.stringify(deco)) {
        prev.end = s.end;
        continue;
      }
    }
    merged.push({ ...s });
  }
  return merged;
}

/** 每个有批注的段落一条边沟记录，按段落顺序。 */
export function gutterMarks(marks: readonly AnnotationMark[]): GutterMark[] {
  const byBlock = new Map<string, AnnotationMark[]>();
  for (const m of marks) {
    const k = `${m.block.start}:${m.block.end}`;
    byBlock.set(k, [...(byBlock.get(k) ?? []), m]);
  }
  return [...byBlock.values()]
    .map((list) => {
      const sorted = [...list].sort((a, b) => a.start - b.start || byWidth(a, b));
      const lead = sorted.find((m) => m.granularity === "block") ?? sorted[0]!;
      return { start: lead.block.start, end: lead.block.end, count: list.length, group: lead.group, ids: sorted.map((m) => m.id) };
    })
    .sort((a, b) => a.start - b.start);
}

/** 边沟角标上的数字：超过 20 显示「20+」。 */
export const gutterLabel = (count: number) => (count > 20 ? "20+" : String(count));

/**
 * 原文一个位置上命中的所有批注，按范围从窄到宽（短语 → 句子 → 段落）。
 * 段落批注按所在块算命中；同范围的按创建时间排。
 */
export function annotationsAt(marks: readonly AnnotationMark[], offset: number): AnnotationMark[] {
  const span = (m: AnnotationMark) => (m.granularity === "block" ? m.block : m);
  return marks
    .filter((m) => {
      const r = span(m);
      return r.start <= offset && offset < r.end;
    })
    .sort((a, b) => {
      const ra = span(a);
      const rb = span(b);
      return ra.end - ra.start - (rb.end - rb.start) || (a.createdAt ?? "").localeCompare(b.createdAt ?? "") || a.id.localeCompare(b.id);
    });
}
