import { describe, expect, it } from "vitest";
import { type ReaderEdge, type ReaderNode, markSegments } from "@reader/core";
import { markdownAdapter } from "@reader/source-markdown";
import { annotationMarksFor, decorateHast } from "../src/reader-marks";

const text = "# 第 1 章\n\nWe divide by the root. Then apply softmax to the scores.\n\nSecond paragraph here.\n";

async function marksFor(nodes: ReaderNode[], edges: ReaderEdge[] = []) {
  const doc = await markdownAdapter.parse("s1", text);
  return { doc, marks: annotationMarksFor(doc, nodes, edges) };
}

const nodeAt = async (id: string, type: "excerpt" | "note", quote: string, extra: Partial<ReaderNode> = {}): Promise<ReaderNode> => {
  const doc = await markdownAdapter.parse("s1", text);
  const start = text.indexOf(quote);
  const anchor = markdownAdapter.selectionToAnchor(doc, { kind: "text", start, end: start + quote.length });
  return { id, x: 0, y: 0, width: 1, height: 1, ...extra, meta: { schemaVersion: 1, type, status: "done", createdBy: "user", createdAt: `2026-11-09T00:00:0${id.length}.000Z`, anchor } };
};

describe("annotationMarksFor", () => {
  it("摘录和批注都画；颗粒度来自锚点；颜色按来源；列表文字取派生的提问", async () => {
    const ex = await nodeAt("ex", "excerpt", "softmax");
    const note = await nodeAt("note", "note", "We divide by the root.", { text: "这是缩放" });
    const op: ReaderNode = { id: "op", x: 0, y: 0, width: 1, height: 1, text: "softmax 在这里做什么？", meta: { schemaVersion: 1, type: "operation", status: "done", createdBy: "user", createdAt: "x" } };
    const { marks } = await marksFor([ex, note, op], [{ id: "e", from: "ex", to: "op", role: "derived" }]);
    expect(marks.map((m) => [m.id, m.granularity, m.group, m.label])).toEqual([
      ["ex", "word", "ai", "softmax 在这里做什么？"],
      ["note", "sentence", "user", "这是缩放"],
    ]);
    const p = text.indexOf("We divide");
    expect(marks[0]!.block).toEqual({ start: p, end: text.indexOf("\n\nSecond") });
  });

  it("别的章、定位失效的不画", async () => {
    const ex = await nodeAt("ex", "excerpt", "softmax");
    const other = { ...ex, id: "o", meta: { ...ex.meta, anchor: { ...ex.meta.anchor!, sourceId: "s2" } } };
    const gone = { ...ex, id: "g", meta: { ...ex.meta, anchor: { ...ex.meta.anchor!, fileHash: "old", quote: { exact: "nowhere", prefix: "", suffix: "" } } } } as ReaderNode;
    const { marks } = await marksFor([other, gone]);
    expect(marks).toEqual([]);
  });
});

describe("decorateHast", () => {
  const span = (s: number, value: string) => ({ type: "element", tagName: "span", properties: { dataS: s, dataE: s + value.length }, children: [{ type: "text", value }] });
  const root = { type: "root" as const, children: [{ type: "element", tagName: "p", properties: {}, children: [span(10, "abcdefghij")] }] };

  it("在区间边界处切开文字 span，每片带自己的偏移，外层句子、里层短语", () => {
    const segs = markSegments([
      { id: "s", sourceId: "x", start: 12, end: 18, granularity: "sentence", group: "user", label: "", block: { start: 0, end: 30 } },
      { id: "p", sourceId: "x", start: 14, end: 16, granularity: "phrase", group: "ai", label: "", block: { start: 0, end: 30 } },
    ]);
    const out = decorateHast(root, segs);
    const p = out.children[0] as { children: Array<{ properties: Record<string, unknown>; children: unknown[] }> };
    const flat = (n: { properties: Record<string, unknown>; children: unknown[] }): string =>
      n.properties.dataS !== undefined ? `[${n.properties.dataS}-${n.properties.dataE}]` : `${String(n.properties.dataKind)}(${(n.children as Array<typeof n>).map(flat).join("")})`;
    expect(p.children.map(flat).join(" ")).toBe("[10-12] sentence([12-14]) sentence(phrase([14-16])) sentence([16-18]) [18-20]");
    // 原树不变
    expect((root.children[0]!.children as unknown[]).length).toBe(1);
  });

  it("文字长度和偏移对不上的 span 整段装饰，不切", () => {
    const odd = { type: "root" as const, children: [{ type: "element", tagName: "span", properties: { dataS: 0, dataE: 9 }, children: [{ type: "text", value: "a&b" }] }] };
    const segs = markSegments([], [{ start: 2, end: 5, word: "x" }]);
    const out = decorateHast(odd, segs) as { children: Array<{ properties: Record<string, unknown> }> };
    expect(out.children[0]!.properties.dataKind).toBeUndefined();
    const hit = decorateHast(odd, markSegments([], [{ start: 0, end: 5, word: "x" }])) as { children: Array<{ properties: Record<string, unknown> }> };
    expect(hit.children[0]!.properties.dataKind).toBe("vocab");
  });
});
