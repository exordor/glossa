/**
 * 全局搜索（Cmd+K）：原文段落和画布卡片。
 * v0.1 是内存里的逐条匹配（一本书几章、几百张卡足够快）；设计文档里的 SQLite FTS5 索引等到 CLI / 跨书搜索时再上，
 * 接口保持「条目进、命中出」不变（见 docs/adr/0003）。
 */

export interface SearchEntry {
  kind: "source" | "node";
  /** source：sourceId；node：nodeId。 */
  id: string;
  /** 结果列表上的出处，如「第 1 章 › 1.2 自注意力」或「回答」。 */
  title: string;
  text: string;
  /** source 条目在原文里的起始偏移（跳回原文用）。 */
  start?: number;
}

export interface SearchHit {
  entry: SearchEntry;
  /** 命中附近的一小段，带省略号。 */
  snippet: string;
  /** 第一个命中在 snippet 里的范围（高亮用）。 */
  mark: [number, number];
  /** 第一个命中在 entry.text 里的偏移。 */
  offset: number;
  score: number;
}

const fold = (s: string) => s.normalize("NFKC").toLowerCase();

/** 把查询拆成词：空白分隔；中文不分词，整段当一个词。 */
export function queryTerms(q: string): string[] {
  return [...new Set(fold(q).split(/\s+/).filter(Boolean))];
}

const SNIPPET = 36;

/**
 * 所有词都出现才算命中（与）。打分：命中次数 + 卡片略优先 + 词在开头附近加分。最多返回 limit 条。
 */
export function search(query: string, entries: SearchEntry[], limit = 30): SearchHit[] {
  const terms = queryTerms(query);
  if (!terms.length) return [];
  const hits: SearchHit[] = [];
  for (const entry of entries) {
    const hay = fold(entry.text);
    const at = terms.map((t) => hay.indexOf(t));
    if (at.some((i) => i < 0)) continue;
    let count = 0;
    for (const t of terms) for (let i = hay.indexOf(t); i >= 0; i = hay.indexOf(t, i + t.length)) count++;
    const offset = Math.min(...at);
    const first = terms[at.indexOf(offset)]!;
    const from = Math.max(0, offset - SNIPPET);
    const to = Math.min(entry.text.length, offset + first.length + SNIPPET);
    const pre = from > 0 ? "…" : "";
    const snippet = pre + entry.text.slice(from, to).replace(/\s+/g, " ") + (to < entry.text.length ? "…" : "");
    // 折叠空白可能让位置前移：按折叠后的前缀长度重算高亮起点。
    const markStart = pre.length + entry.text.slice(from, offset).replace(/\s+/g, " ").length;
    hits.push({
      entry,
      snippet,
      mark: [markStart, markStart + first.length],
      offset,
      score: count + (entry.kind === "node" ? 0.5 : 0) + (offset < 40 ? 0.25 : 0),
    });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** 把一章原文切成段落条目（按空行分），带起始偏移；出处写成「章名 › 最近的小标题」。 */
export function paragraphEntries(sourceId: string, chapter: string, text: string): SearchEntry[] {
  const out: SearchEntry[] = [];
  let heading = "";
  for (const m of text.matchAll(/[^\n]+(?:\n(?!\s*\n)[^\n]*)*/g)) {
    const t = m[0].trim();
    if (!t) continue;
    const h = /^#{1,6}\s+(.*)$/.exec(t);
    if (h) heading = h[1]!.trim();
    const title = heading && heading !== chapter ? `${chapter} › ${heading}` : chapter;
    out.push({ kind: "source", id: sourceId, title, text: m[0], start: m.index ?? 0 });
  }
  return out;
}
