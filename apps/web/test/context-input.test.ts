import { describe, expect, it } from "vitest";
import type { Anchor, Book, ReaderEdge, ReaderNode } from "@reader/core";
import { contextBaseFor } from "../src/context-input";

const book: Book = { schemaVersion: 1, id: "b", title: "示例书", sources: [{ id: "s1", kind: "markdown", path: "01.md", hash: "h", order: 1, title: "第 1 章" }] };
const anchor = (blockIndex: number, exact: string): Anchor => ({
  kind: "markdown",
  sourceId: "s1",
  headingPath: ["第 1 章", "1.2"],
  blockIndex,
  start: 0,
  end: 1,
  fileHash: "h",
  quote: { exact, prefix: "", suffix: "" },
  granularity: "phrase",
});
const node = (id: string, type: ReaderNode["meta"]["type"], extra: Partial<ReaderNode> & { anchor?: Anchor; at?: string; status?: ReaderNode["meta"]["status"] } = {}): ReaderNode => ({
  id,
  x: 0,
  y: 0,
  width: 1,
  height: 1,
  ...(extra.text !== undefined ? { text: extra.text } : {}),
  ...(extra.label !== undefined ? { label: extra.label } : {}),
  meta: {
    schemaVersion: 1,
    type,
    status: extra.status ?? "done",
    createdBy: "user",
    createdAt: extra.at ?? "2026-11-08T00:00:00.000Z",
    ...(extra.anchor ? { anchor: extra.anchor } : {}),
  },
});

describe("contextBaseFor", () => {
  const nodes = [
    node("n1", "note", { anchor: anchor(0, "dot"), text: "我觉得是缩放", at: "2026-11-08T01:00:00.000Z" }),
    node("n2", "note", { anchor: anchor(1, "别段"), text: "别的段" }),
    node("n3", "note", { anchor: anchor(0, "dot"), text: "dot" }), // 批注为空（等于原文）不算
    node("x1", "excerpt", { anchor: anchor(0, "softmax") }),
    node("a1", "answer", { text: "结论一\n\n- 要点", label: "解释", at: "2026-11-08T02:00:00.000Z" }),
    node("x2", "excerpt", { anchor: anchor(0, "本次") }),
    node("a2", "answer", { text: "", status: "running" }),
  ];
  const edges: ReaderEdge[] = [
    { id: "e1", from: "x1", to: "a1", role: "derived" },
    { id: "e2", from: "x2", to: "a2", role: "derived" },
  ];

  it("收集同一段的批注和之前的问答，排除本次的卡", () => {
    const b = contextBaseFor({ book, anchor: anchor(0, "本次"), part: { selected: "本次", headingPath: ["第 1 章", "1.2"] }, nodes, edges, excerptNodeId: "x2", answerNodeId: "a2" });
    expect(b.book).toEqual({ title: "示例书" });
    expect(b.chapter).toBe("第 1 章");
    expect(b.excerpts).toEqual([{ selected: "本次", headingPath: ["第 1 章", "1.2"], nodeId: "x2" }]);
    expect(b.notes).toEqual([{ nodeId: "n1", text: "我觉得是缩放", quote: "dot" }]);
    expect(b.conversation).toEqual([{ nodeId: "a1", question: "解释「softmax」", answer: "结论一\n\n- 要点", summary: "结论一" }]);
  });
});
