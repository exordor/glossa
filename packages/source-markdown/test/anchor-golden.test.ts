/**
 * 锚点黄金测试（计划第 10 步，设计文档成功指标「锚点失效率 < 2%」）。
 *
 * 做法：在语料每个段落上取词、短语、整句三种锚点，然后对原文做三类修改——改标题、插段、改字——以及三类混合，
 * 再用三层定位找回每个锚点，和「按修改推算出的正确位置」比对。
 *
 * - 锚点自己的文字被改到的（touched）不算进分母：原话已经不在了，找不到是对的。只统计它们被定位到别处的次数（误命中）。
 * - 失效率 =（找不到 + 找错位置）/ 文字没被改到的锚点数。每类修改都要 < 2%，误命中（找错位置）要为 0。
 * - 修改用固定种子的伪随机数，结果可复现；改语料或算法后跑 `ANCHOR_REPORT=1 pnpm vitest run anchor-golden` 看各层命中分布。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { MarkdownAnchor } from "@reader/core";
import { markdownAdapter } from "../src/index.js";

const fixture = (p: string) => readFileSync(new URL(`../../../fixtures/${p}`, import.meta.url), "utf8");
const CORPUS: Record<string, string> = {
  "optimisation.md": fixture("anchor-golden/optimisation.md"),
  "zh-reading.md": fixture("anchor-golden/zh-reading.md"),
  "sample-01.md": fixture("sample-book/01-attention.md"),
  "sample-02.md": fixture("sample-book/02-multi-head.md"),
  "sample-03.md": fixture("sample-book/03-position.md"),
};
const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];
const THRESHOLD = 0.02;

/* ---------- 可复现的随机数 ---------- */
function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next, int: (n: number) => Math.floor(next() * n), pick: <T>(xs: readonly T[]) => xs[Math.floor(next() * xs.length)]! };
}
type Rng = ReturnType<typeof rng>;

/* ---------- 修改：一组互不重叠的替换，可以推算旧偏移在新文本里的位置 ---------- */
interface Edit {
  at: number;
  del: number;
  ins: string;
}

function applyEdits(text: string, edits: Edit[]) {
  const sorted = [...edits].sort((a, b) => a.at - b.at || a.del - b.del);
  const kept: Edit[] = [];
  let end = -1;
  for (const e of sorted) {
    if (e.at < end || (e.at === end && e.del > 0 && kept.at(-1)?.del)) continue; // 重叠的丢掉
    kept.push(e);
    end = e.at + e.del;
  }
  let out = "";
  let pos = 0;
  for (const e of kept) {
    out += text.slice(pos, e.at) + e.ins;
    pos = e.at + e.del;
  }
  out += text.slice(pos);
  /** 旧偏移 → 新偏移（锚点区间没被改到时用）。插入点正好在 p 上时，p 之前的插入算在前面。 */
  const map = (p: number, side: "start" | "end") => {
    let d = 0;
    for (const e of kept) {
      if (e.at + e.del < p || (e.at + e.del === p && (e.del > 0 || side === "start"))) d += e.ins.length - e.del;
    }
    return p + d;
  };
  const touched = (s: number, t: number) => kept.some((e) => (e.del > 0 ? e.at < t && e.at + e.del > s : e.at > s && e.at < t));
  return { text: out, map, touched };
}

const isCjk = (s: string) => /[一-鿿]/.test(s);

/** 改标题：每个标题后面加字（标题路径全变，第一层失效）。 */
function renameHeadings(text: string): Edit[] {
  const edits: Edit[] = [];
  for (const m of text.matchAll(/^#{1,6} [^\n]+$/gm)) edits.push({ at: m.index! + m[0].length, del: 0, ins: isCjk(m[0]) ? "（修订）" : " (revised)" });
  return edits;
}

/** 插段：在随机的块边界插入新段落，新段落里故意重复语料里的词，增加歧义。 */
function insertParagraphs(text: string, starts: number[], r: Rng, n = 3): Edit[] {
  const words = text.match(isCjk(text) ? /[一-鿿]{2,4}/g : /[A-Za-z]{4,}/g) ?? [];
  const edits: Edit[] = [];
  for (let i = 0; i < n; i++) {
    const at = r.pick(starts);
    const filler = Array.from({ length: 8 }, () => r.pick(words)).join(isCjk(text) ? "" : " ");
    edits.push({ at, del: 0, ins: isCjk(text) ? `新插入的一段：${filler}。\n\n` : `An inserted paragraph about ${filler}.\n\n` });
  }
  return edits;
}

/** 改字：随机挑约 6% 的词，换成语料里的另一个词。 */
function rewordWords(text: string, r: Rng, rate = 0.06): Edit[] {
  const re = isCjk(text) ? /[一-鿿]{2}/g : /[A-Za-z]{3,}/g;
  const words = [...text.matchAll(re)];
  const edits: Edit[] = [];
  for (const m of words) {
    if (r.next() >= rate) continue;
    let w = r.pick(words)[0];
    if (w === m[0]) w = `${w}x`;
    edits.push({ at: m.index!, del: m[0].length, ins: w });
  }
  return edits;
}

/* ---------- 锚点：每个段落取词、短语、整句 ---------- */
interface Sample {
  start: number;
  end: number;
  kind: "word" | "phrase" | "sentence";
}

interface Block {
  start: number;
  end: number;
  node: { type: string };
}

function sampleAnchors(text: string, blocks: Block[], r: Rng): Sample[] {
  const out: Sample[] = [];
  for (const b of blocks) {
    if (b.node.type !== "paragraph") continue;
    const para = text.slice(b.start, b.end);
    if (isCjk(para)) {
      const s = /^[^。！？]+[。！？]/.exec(para);
      if (s) out.push({ start: b.start, end: b.start + s[0].length, kind: "sentence" });
      const hans = [...para.matchAll(/[一-鿿]+/g)].filter((m) => m[0].length >= 6);
      if (hans.length) {
        const m = r.pick(hans);
        const len = 4 + r.int(Math.min(5, m[0].length - 3));
        const off = r.int(m[0].length - len + 1);
        out.push({ start: b.start + m.index! + off, end: b.start + m.index! + off + len, kind: "phrase" });
        const w = r.pick(hans);
        const wo = r.int(w[0].length - 1);
        out.push({ start: b.start + w.index! + wo, end: b.start + w.index! + wo + 2, kind: "word" });
      }
      continue;
    }
    const s = /^[^.?!]+[.?!]/.exec(para);
    if (s) out.push({ start: b.start, end: b.start + s[0].length, kind: "sentence" });
    const words = [...para.matchAll(/[A-Za-z][A-Za-z'-]*/g)];
    if (words.length >= 5) {
      const i = r.int(words.length - 4);
      const len = 3 + r.int(3);
      const first = words[i]!;
      const last = words[Math.min(i + len - 1, words.length - 1)]!;
      out.push({ start: b.start + first.index!, end: b.start + last.index! + last[0].length, kind: "phrase" });
    }
    const long = words.filter((w) => w[0].length >= 4);
    if (long.length) {
      const w = r.pick(long);
      out.push({ start: b.start + w.index!, end: b.start + w.index! + w[0].length, kind: "word" });
    }
  }
  return out;
}

/* ---------- 跑一轮，统计 ---------- */
interface Stats {
  anchors: number;
  untouched: number;
  layer: [number, number, number];
  lost: number;
  wrong: number;
  touchedWrong: number;
}
const empty = (): Stats => ({ anchors: 0, untouched: 0, layer: [0, 0, 0], lost: 0, wrong: 0, touchedWrong: 0 });

/** heavy：三类一起、强度加大（插 8 段、改 15% 的词），看压力下的余量。 */
type Kind = "rename" | "insert" | "reword" | "mixed" | "heavy";
const KINDS: Kind[] = ["rename", "insert", "reword", "mixed", "heavy"];

async function run(kind: Kind): Promise<{ stats: Stats; failures: string[] }> {
  const stats = empty();
  const failures: string[] = [];
  for (const [name, text] of Object.entries(CORPUS)) {
    const doc = await markdownAdapter.parse(name, text);
    const blocks = (doc.tree as { blocks: Block[] }).blocks;
    for (const seed of SEEDS) {
      const r = rng(seed * 7919 + name.length);
      const samples = sampleAnchors(text, blocks, r);
      const edits: Edit[] = [];
      const heavy = kind === "heavy";
      if (kind === "rename" || kind === "mixed" || heavy) edits.push(...renameHeadings(text));
      if (kind === "insert" || kind === "mixed" || heavy) edits.push(...insertParagraphs(text, blocks.map((b) => b.start), r, heavy ? 8 : 3));
      if (kind === "reword" || kind === "mixed" || heavy) edits.push(...rewordWords(text, r, heavy ? 0.15 : 0.06));
      const edited = applyEdits(text, edits);
      const doc2 = await markdownAdapter.parse(name, edited.text);
      for (const s of samples) {
        const anchor = markdownAdapter.selectionToAnchor(doc, { kind: "text", start: s.start, end: s.end }) as MarkdownAnchor;
        const loc = markdownAdapter.resolve(doc2, anchor);
        stats.anchors++;
        if (edited.touched(s.start, s.end)) {
          if (loc && edited.text.slice(loc.start, loc.end) !== anchor.quote.exact) stats.touchedWrong++;
          continue;
        }
        stats.untouched++;
        const want = { start: edited.map(s.start, "start"), end: edited.map(s.end, "end") };
        if (!loc) {
          stats.lost++;
          failures.push(`${name}#${seed} 找不到 ${s.kind}「${anchor.quote.exact.slice(0, 40)}」`);
        } else if (loc.start !== want.start || loc.end !== want.end) {
          stats.wrong++;
          failures.push(`${name}#${seed} 找错 ${s.kind}「${anchor.quote.exact.slice(0, 40)}」 第 ${loc.layer} 层 → ${loc.start}，应为 ${want.start}`);
        } else stats.layer[loc.layer - 1]!++;
      }
    }
  }
  return { stats, failures };
}

const rate = (s: Stats) => (s.lost + s.wrong) / s.untouched;

describe("锚点黄金测试：改标题、插段、改字后三层定位的命中率", () => {
  for (const kind of KINDS) {
    it(`${kind}：失效率 < 2%，不找错位置`, async () => {
      const { stats, failures } = await run(kind);
      if (process.env.ANCHOR_REPORT) {
        const pct = (n: number) => `${((n / stats.untouched) * 100).toFixed(1)}%`;
        console.info(
          `[${kind}] 锚点 ${stats.anchors}，文字未被改 ${stats.untouched}：第一层 ${pct(stats.layer[0])} · 第二层 ${pct(stats.layer[1])} · 第三层 ${pct(stats.layer[2])} · 找不到 ${stats.lost} · 找错 ${stats.wrong}；文字被改后误命中 ${stats.touchedWrong}`,
          failures.length ? `\n  ${failures.slice(0, 10).join("\n  ")}` : "",
        );
      }
      expect(stats.untouched).toBeGreaterThan(200);
      expect(stats.wrong, failures.join("\n")).toBe(0);
      expect(rate(stats), failures.join("\n")).toBeLessThan(THRESHOLD);
    });
  }

  it("修改工具自检：偏移推算正确", () => {
    const e = applyEdits("abc def ghi", [
      { at: 4, del: 3, ins: "XYZW" },
      { at: 0, del: 0, ins: ">>" },
    ]);
    expect(e.text).toBe(">>abc XYZW ghi");
    expect(e.text.slice(e.map(8, "start"), e.map(11, "end"))).toBe("ghi");
    expect(e.text.slice(e.map(0, "start"), e.map(3, "end"))).toBe(">>abc".slice(0, 0) + "abc");
    expect(e.touched(4, 7)).toBe(true);
    expect(e.touched(8, 11)).toBe(false);
  });
});
