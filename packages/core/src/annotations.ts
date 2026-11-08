/**
 * 多层批注的包含树（设计文档「多层批注」）。
 * 存储平铺、不存层级；层级在需要时由范围包含关系算出。算法确定，CLI / MCP / 界面结果一致：
 * 同一 Source 内按 start 升序、end 降序排，每个锚点的父节点 = 前面最近一个完全包含它的锚点。
 * 交叉而不包含的两个范围是兄弟。范围完全相同时当兄弟处理。
 */
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
