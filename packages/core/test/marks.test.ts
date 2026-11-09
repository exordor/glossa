/** 多层批注的显示通道：句子背景、短语下划线、生词点线、边沟、叠层命中顺序。 */
import { describe, expect, it } from "vitest";
import { type AnnotationMark, annotationsAt, gutterLabel, gutterMarks, markSegments } from "../src/index.js";

const block = { start: 0, end: 100 };
const m = (id: string, granularity: AnnotationMark["granularity"], start: number, end: number, group: AnnotationMark["group"] = "ai", createdAt = id): AnnotationMark => ({
  id,
  sourceId: "s",
  granularity,
  start,
  end,
  group,
  createdAt,
  label: id,
  block,
});

describe("markSegments", () => {
  it("句子背景和短语下划线叠在一起，各占一个通道", () => {
    const segs = markSegments([m("s1", "sentence", 10, 50), m("p1", "phrase", 20, 30, "user")]);
    expect(segs).toEqual([
      { start: 10, end: 20, sentence: { group: "ai", level: 1 } },
      { start: 20, end: 30, sentence: { group: "ai", level: 1 }, phrase: { group: "user", overlap: false } },
      { start: 30, end: 50, sentence: { group: "ai", level: 1 } },
    ]);
  });

  it("同层重叠：句子加深一级最多两级，短语变双线", () => {
    const segs = markSegments([m("a", "sentence", 0, 40), m("b", "sentence", 10, 40), m("c", "sentence", 20, 40), m("p", "word", 25, 30), m("q", "phrase", 25, 35)]);
    const at = (o: number) => segs.find((s) => s.start <= o && o < s.end);
    expect(at(5)?.sentence?.level).toBe(1);
    expect(at(22)?.sentence?.level).toBe(2);
    expect(at(25)?.phrase).toEqual({ group: "ai", overlap: true });
    expect(at(30)?.phrase?.overlap).toBe(false);
  });

  it("生词点线最低优先级：被短语批注覆盖的部分不画", () => {
    const segs = markSegments([m("p", "phrase", 10, 15)], [{ start: 12, end: 20, word: "saturating" }]);
    expect(segs).toEqual([
      { start: 10, end: 15, phrase: { group: "ai", overlap: false } },
      { start: 15, end: 20, vocab: "saturating" },
    ]);
  });

  it("段落批注不进行内装饰（只画边沟）", () => {
    expect(markSegments([m("b", "block", 0, 100)])).toEqual([]);
  });
});

describe("gutterMarks", () => {
  it("每段一条，数本段全部批注，有段落批注时颜色取它", () => {
    const other = { start: 100, end: 200 };
    const g = gutterMarks([m("s", "sentence", 10, 20, "ai"), m("b", "block", 0, 100, "user"), { ...m("x", "phrase", 120, 130), block: other }]);
    expect(g).toEqual([
      { start: 0, end: 100, count: 2, group: "user", ids: ["b", "s"] },
      { start: 100, end: 200, count: 1, group: "ai", ids: ["x"] },
    ]);
    expect(gutterLabel(20)).toBe("20");
    expect(gutterLabel(21)).toBe("20+");
  });
});

describe("annotationsAt", () => {
  it("从窄到宽：短语 → 句子 → 段落；同范围按创建时间", () => {
    const marks = [m("b", "block", 0, 100), m("s", "sentence", 10, 50), m("p2", "phrase", 20, 30, "ai", "2"), m("p1", "phrase", 20, 30, "ai", "1")];
    expect(annotationsAt(marks, 25).map((x) => x.id)).toEqual(["p1", "p2", "s", "b"]);
    expect(annotationsAt(marks, 5).map((x) => x.id)).toEqual(["b"]);
    expect(annotationsAt(marks, 100)).toEqual([]);
  });
});
