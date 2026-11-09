/**
 * 注意力机制的纯逻辑（设计文档「注意力与信息过载」、v0.1 计划第 8 步）：
 * 跟随阅读（章节节点群的范围）、视口外新卡提示（方向）、聚焦模式（上下游集合）。
 */
import type { ReaderEdge, ReaderNode } from "@reader/core";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const union = (rs: Rect[]): Rect | null => {
  if (!rs.length) return null;
  const x = Math.min(...rs.map((r) => r.x));
  const y = Math.min(...rs.map((r) => r.y));
  return { x, y, w: Math.max(...rs.map((r) => r.x + r.w)) - x, h: Math.max(...rs.map((r) => r.y + r.h)) - y };
};

const rectOf = (n: ReaderNode): Rect => ({ x: n.x, y: n.y, w: n.width, h: n.height });

/**
 * 一章的节点群：章节卡 + 锚在这一章的卡 + 从它们衍生出来的卡（沿连线向下游）。
 * 只有章节卡时也返回它的范围；这一章在画布上没有卡时返回 null。
 */
export function chapterCluster(nodes: ReaderNode[], edges: ReaderEdge[], sourceId: string): Rect | null {
  const ids = new Set(nodes.filter((n) => n.meta.type !== "group" && n.meta.anchor?.sourceId === sourceId).map((n) => n.id));
  const out = new Map<string, string[]>();
  for (const e of edges) out.set(e.from, [...(out.get(e.from) ?? []), e.to]);
  const queue = [...ids];
  while (queue.length) {
    for (const to of out.get(queue.pop()!) ?? []) {
      if (!ids.has(to)) {
        ids.add(to);
        queue.push(to);
      }
    }
  }
  return union(nodes.filter((n) => ids.has(n.id)).map(rectOf));
}

/** 聚焦模式：一张卡和它的全部上游、下游（沿连线双向传递）。 */
export function focusSet(nodeId: string, edges: ReaderEdge[]): Set<string> {
  const set = new Set([nodeId]);
  const walk = (dir: "up" | "down") => {
    const queue = [nodeId];
    while (queue.length) {
      const cur = queue.pop()!;
      for (const e of edges) {
        const [a, b] = dir === "down" ? [e.from, e.to] : [e.to, e.from];
        if (a === cur && !set.has(b)) {
          set.add(b);
          queue.push(b);
        }
      }
    }
  };
  walk("up");
  walk("down");
  return set;
}

export type Direction = "left" | "right" | "up" | "down";

/** 矩形在视口外时给出方向（主方向取偏离更多的那一轴）；和视口有交集时返回 null。 */
export function offscreenDirection(viewport: Rect, r: Rect): Direction | null {
  const dx = r.x + r.w < viewport.x ? r.x + r.w - viewport.x : r.x > viewport.x + viewport.w ? r.x - (viewport.x + viewport.w) : 0;
  const dy = r.y + r.h < viewport.y ? r.y + r.h - viewport.y : r.y > viewport.y + viewport.h ? r.y - (viewport.y + viewport.h) : 0;
  if (!dx && !dy) return null;
  if (Math.abs(dx) >= Math.abs(dy)) return dx < 0 ? "left" : "right";
  return dy < 0 ? "up" : "down";
}
