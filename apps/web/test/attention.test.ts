import { describe, expect, it } from "vitest";
import type { ReaderEdge, ReaderNode } from "@reader/core";
import { chapterCluster, focusSet, offscreenDirection } from "../src/attention";

const n = (id: string, x: number, y: number, sourceId?: string): ReaderNode => ({
  id,
  x,
  y,
  width: 100,
  height: 50,
  meta: {
    schemaVersion: 1,
    type: sourceId ? "excerpt" : "answer",
    status: "done",
    createdBy: "user",
    createdAt: "2026-11-09T00:00:00.000Z",
    ...(sourceId
      ? { anchor: { kind: "markdown", sourceId, headingPath: [], blockIndex: 0, start: 0, end: 1, fileHash: "h", quote: { exact: "x", prefix: "", suffix: "" }, granularity: "word" } }
      : {}),
  },
});
const e = (from: string, to: string): ReaderEdge => ({ id: `${from}-${to}`, from, to, role: "derived" });

describe("注意力", () => {
  const nodes = [n("c1", 0, 0, "s1"), n("x1", 0, 100, "s1"), n("a1", 0, 200), n("a2", 300, 400), n("c2", 1000, 0, "s2")];
  const edges = [e("x1", "a1"), e("a1", "a2"), e("c2", "z")];

  it("章节节点群：锚在这一章的卡 + 下游衍生的卡", () => {
    expect(chapterCluster(nodes, edges, "s1")).toEqual({ x: 0, y: 0, w: 400, h: 450 });
    expect(chapterCluster(nodes, edges, "s2")).toEqual({ x: 1000, y: 0, w: 100, h: 50 });
    expect(chapterCluster(nodes, edges, "s9")).toBeNull();
  });

  it("聚焦：上游和下游都保留，旁支不保留", () => {
    const es = [e("x1", "a1"), e("a1", "a2"), e("x2", "a3"), e("n1", "a1")];
    expect([...focusSet("a1", es)].sort()).toEqual(["a1", "a2", "n1", "x1"]);
    expect([...focusSet("a3", es)].sort()).toEqual(["a3", "x2"]);
  });

  it("视口外方向：取偏离更多的那一轴；有交集返回 null", () => {
    const v = { x: 0, y: 0, w: 1000, h: 800 };
    expect(offscreenDirection(v, { x: 100, y: 100, w: 50, h: 50 })).toBeNull();
    expect(offscreenDirection(v, { x: 990, y: 100, w: 50, h: 50 })).toBeNull();
    expect(offscreenDirection(v, { x: 1200, y: 900, w: 50, h: 50 })).toBe("right");
    expect(offscreenDirection(v, { x: 100, y: 1500, w: 50, h: 50 })).toBe("down");
    expect(offscreenDirection(v, { x: -300, y: 100, w: 50, h: 50 })).toBe("left");
    expect(offscreenDirection(v, { x: 100, y: -300, w: 50, h: 50 })).toBe("up");
  });
});
