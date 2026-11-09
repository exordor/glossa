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

/** 最长公共子序列长度：前后文里改了一两个词、插了几个字时，仍能按「大部分还在」打分。 */
function lcsLen(a: string, b: string): number {
  if (!a || !b) return 0;
  let prev = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1]! + 1 : Math.max(prev[j]!, cur[j - 1]!);
    prev = cur;
  }
  return prev[b.length]!;
}

/**
 * 引文在 [from, to) 里每一处出现的前后文得分。得分 = 前文、后文各自的最长公共子序列长度，
 * 紧挨着的完全一致部分再加一点权重（同样「大部分还在」时，贴着引文的字没变更可信）。
 */
export function scoreQuote(text: string, quote: Quote, from = 0, to = text.length): Array<{ start: number; end: number; score: number }> {
  const out: Array<{ start: number; end: number; score: number }> = [];
  if (!quote.exact) return out;
  for (let i = text.indexOf(quote.exact, from); i !== -1 && i + quote.exact.length <= to; i = text.indexOf(quote.exact, i + 1)) {
    const before = text.slice(Math.max(0, i - quote.prefix.length), i);
    const after = text.slice(i + quote.exact.length, i + quote.exact.length + quote.suffix.length);
    const near = commonSuffixLen(before, quote.prefix) + commonPrefixLen(after, quote.suffix);
    out.push({ start: i, end: i + quote.exact.length, score: lcsLen(before, quote.prefix) + lcsLen(after, quote.suffix) + near / 4 });
  }
  return out;
}

/**
 * 在文本里找引文。exact 出现多次时，按前后文得分（scoreQuote）取最高；hint 是旧偏移，同分时取最近的。
 * 找不到 exact 返回 null。
 */
export function findQuote(text: string, quote: Quote, hint = 0): { start: number; end: number; score: number } | null {
  let best: { start: number; end: number; score: number } | null = null;
  for (const c of scoreQuote(text, quote)) {
    if (!best || c.score > best.score || (c.score === best.score && Math.abs(c.start - hint) < Math.abs(best.start - hint))) best = c;
  }
  return best;
}
