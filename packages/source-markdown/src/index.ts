/**
 * Markdown 来源适配器。锚点三层定位（设计文档「核心概念与数据模型」）：
 *   1. 标题路径 + 块序号；2. 字符偏移 + 文件 hash；3. 引文 exact + 前后文。
 * 块 = 顶层的段落、列表、代码块、公式、表格、引用、图片段落（标题本身不计入块序号）。
 */
import type { Heading as MdHeading, Root, RootContent } from "mdast";
import { toString } from "mdast-util-to-string";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import { unified } from "unified";
import {
  type Anchor,
  type ContextPart,
  type Granularity,
  type Heading,
  type Location,
  type MarkdownAnchor,
  type Registry,
  type Selection,
  type SourceAdapter,
  type SourceDoc,
  contentHash,
  findQuote,
  scoreQuote,
  makeQuote,
} from "@reader/core";

interface Block {
  start: number;
  end: number;
  headingPath: string[];
  index: number;
  node: RootContent;
}

interface MdTree {
  root: Root;
  blocks: Block[];
}

const processor = unified().use(remarkParse).use(remarkGfm).use(remarkMath);

function blocksOf(root: Root): { blocks: Block[]; headings: Heading[] } {
  const blocks: Block[] = [];
  const headings: Heading[] = [];
  const path: Array<{ depth: number; text: string }> = [];
  let index = 0;
  for (const node of root.children) {
    const start = node.position?.start.offset ?? 0;
    const end = node.position?.end.offset ?? start;
    if (node.type === "heading") {
      const h = node as MdHeading;
      const text = toString(h);
      while (path.length && path[path.length - 1]!.depth >= h.depth) path.pop();
      path.push({ depth: h.depth, text });
      headings.push({ depth: h.depth, text, position: start });
      index = 0;
      continue;
    }
    if (node.type === "definition" || node.type === "html") continue;
    blocks.push({ start, end, headingPath: path.map((p) => p.text), index: index++, node });
  }
  return { blocks, headings };
}

function treeOf(doc: SourceDoc): MdTree {
  return doc.tree as MdTree;
}

function blockAt(doc: SourceDoc, offset: number): Block | undefined {
  return treeOf(doc).blocks.find((b) => b.start <= offset && offset < b.end) ??
    treeOf(doc).blocks.filter((b) => b.start <= offset).at(-1);
}

/** 原文位置所在的顶层块（段落、列表、代码块…）的范围；阅读器边沟按它画。 */
export function blockRange(doc: SourceDoc, offset: number): { start: number; end: number } | null {
  const b = blockAt(doc, offset);
  return b ? { start: b.start, end: b.end } : null;
}

const SENTENCE_END = /[.?!;。？！；]/;

function sentenceRange(text: string, block: Block, start: number, end: number): [number, number] {
  let s = start;
  while (s > block.start && !SENTENCE_END.test(text[s - 1]!)) s--;
  while (s < start && /\s/.test(text[s]!)) s++;
  let e = end;
  while (e < block.end && !SENTENCE_END.test(text[e - 1] ?? "")) e++;
  return [s, Math.min(e, block.end)];
}

function guessGranularity(text: string, block: Block, start: number, end: number): Granularity {
  const sel = text.slice(start, end).trim();
  const blockText = text.slice(block.start, block.end).trim();
  if (sel === blockText) return "block";
  const [s, e] = sentenceRange(text, block, start, end);
  if (sel === text.slice(s, e).trim()) return "sentence";
  return /\s/.test(sel) ? "phrase" : "word";
}

export const markdownAdapter: SourceAdapter = {
  id: "markdown",
  kind: "markdown",
  extensions: [".md", ".markdown"],

  async parse(sourceId, content) {
    const text = typeof content === "string" ? content : new TextDecoder().decode(content);
    const root = processor.parse(text) as Root;
    const { blocks, headings } = blocksOf(root);
    const tree: MdTree = { root, blocks };
    return { sourceId, kind: "markdown", hash: contentHash(text), text, headings, tree };
  },

  outline(doc) {
    return doc.headings;
  },

  selectionToAnchor(doc, sel: Selection, granularity?: Granularity): Anchor {
    if (sel.kind !== "text") throw new Error("Markdown 来源只支持文字选区");
    const block = blockAt(doc, sel.start);
    if (!block) throw new Error("选区不在任何块内");
    const anchor: MarkdownAnchor = {
      kind: "markdown",
      sourceId: doc.sourceId,
      headingPath: block.headingPath,
      blockIndex: block.index,
      start: sel.start,
      end: sel.end,
      fileHash: doc.hash,
      quote: makeQuote(doc.text, sel.start, sel.end),
      granularity: granularity ?? guessGranularity(doc.text, block, sel.start, sel.end),
    };
    return anchor;
  },

  resolve(doc, anchor): Location | null {
    if (anchor.kind !== "markdown") return null;
    const { text } = doc;
    // 第二层先查最便宜的：hash 一致时偏移精确命中。
    if (anchor.fileHash === doc.hash && text.slice(anchor.start, anchor.end) === anchor.quote.exact) {
      return { sourceId: doc.sourceId, start: anchor.start, end: anchor.end, layer: 2 };
    }
    // 第一层：标题路径 + 块序号，在块内找引文；第三层：全文按引文 + 前后文打分。
    // 插段后同一序号的块可能换成了别的段落，里面碰巧也有这个词：块内候选的前后文得分必须不低于全文最高分，
    // 否则以第三层为准（锚点黄金测试抓到的问题）。
    const global = findQuote(text, anchor.quote, anchor.start);
    const block = treeOf(doc).blocks.find(
      (b) => b.index === anchor.blockIndex && b.headingPath.join("\u0000") === anchor.headingPath.join("\u0000"),
    );
    if (block && global) {
      const inBlock = scoreQuote(text, anchor.quote, block.start, block.end).sort(
        (a, b) => b.score - a.score || Math.abs(a.start - anchor.start) - Math.abs(b.start - anchor.start),
      )[0];
      if (inBlock && inBlock.score >= global.score) return { sourceId: doc.sourceId, start: inBlock.start, end: inBlock.end, layer: 1 };
    }
    return global ? { sourceId: doc.sourceId, start: global.start, end: global.end, layer: 3 } : null;
  },

  extract(doc, anchor): ContextPart {
    const loc = this.resolve(doc, anchor);
    const start = loc?.start ?? 0;
    const end = loc?.end ?? 0;
    const selected = loc ? doc.text.slice(start, end) : anchor.quote.exact;
    const block = loc ? blockAt(doc, start) : undefined;
    const part: ContextPart = {
      kind: "text",
      selected,
      headingPath: block?.headingPath ?? (anchor.kind === "markdown" ? anchor.headingPath : []),
    };
    if (block && anchor.granularity !== "block") {
      const [s, e] = sentenceRange(doc.text, block, start, end);
      part.sentence = doc.text.slice(s, e).trim();
      part.paragraph = doc.text.slice(block.start, block.end).trim();
    }
    if (block) {
      const { blocks } = treeOf(doc);
      const i = blocks.indexOf(block);
      const same = (b: Block | undefined) => b !== undefined && b.headingPath.join("\u0000") === block.headingPath.join("\u0000");
      const textOf = (b: Block) => doc.text.slice(b.start, b.end).trim();
      const before = [blocks[i - 2], blocks[i - 1]].filter(same).map((b) => textOf(b!));
      const after = [blocks[i + 1], blocks[i + 2]].filter(same).map((b) => textOf(b!));
      // 块级选中时所在段就是选中本身，前后文照样给。
      if (before.length) part.before = before;
      if (after.length) part.after = after;
    }
    return part;
  },
};

/** 内置适配器也走注册表，不走后门。 */
export function registerMarkdownSource(registry: Registry) {
  return registry.register("source", markdownAdapter);
}
