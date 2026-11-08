/**
 * 引文选择器（W3C TextQuoteSelector）：创建与重新定位。前后文各取 32 字。
 */
import type { Quote } from "./types.js";

export const QUOTE_CONTEXT = 32;

export function makeQuote(text: string, start: number, end: number): Quote {
  return {
    exact: text.slice(start, end),
    prefix: text.slice(Math.max(0, start - QUOTE_CONTEXT), start),
    suffix: text.slice(end, end + QUOTE_CONTEXT),
  };
}

function commonSuffixLen(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}
function commonPrefixLen(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

/**
 * 在文本里找引文。exact 出现多次时，用前后文重合长度打分取最高；hint 是旧偏移，同分时取最近的。
 * 找不到 exact 返回 null（v0.1 只做精确 exact + 前后文消歧，编辑距离模糊匹配留到锚点黄金测试一起做）。
 */
export function findQuote(text: string, quote: Quote, hint = 0): { start: number; end: number } | null {
  if (!quote.exact) return null;
  let best: { start: number; score: number } | null = null;
  for (let i = text.indexOf(quote.exact); i !== -1; i = text.indexOf(quote.exact, i + 1)) {
    const before = text.slice(Math.max(0, i - quote.prefix.length), i);
    const after = text.slice(i + quote.exact.length, i + quote.exact.length + quote.suffix.length);
    const score = commonSuffixLen(before, quote.prefix) + commonPrefixLen(after, quote.suffix);
    if (!best || score > best.score || (score === best.score && Math.abs(i - hint) < Math.abs(best.start - hint))) {
      best = { start: i, score };
    }
  }
  return best ? { start: best.start, end: best.start + quote.exact.length } : null;
}
