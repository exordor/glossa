/**
 * 生词本（设计文档：跨书的用户级概念 Vocab，存 ~/.reader/vocab.jsonl，每条带原句锚点）。
 * 存储是追加写的查词记录：查一次词义写一行；生词表、查词次数由记录折叠出来。追加写不怕并发、不会写坏旧行。
 * 读入时保留所有未知字段；每行带 schemaVersion，键按固定顺序序列化。
 */
import type { Anchor } from "./types.js";
import { SCHEMA_VERSION } from "./types.js";
import { sortKeys } from "./stable-json.js";

/** vocab.jsonl 的一行：一次查词。 */
export interface VocabRecord {
  schemaVersion: number;
  /** 规整后的词（小写、去首尾标点），折叠的键。 */
  word: string;
  /** 原文里的写法。 */
  display: string;
  at: string;
  /** 在哪本书、哪一章、哪一句查的。 */
  bookId: string;
  bookTitle?: string;
  sourceId: string;
  sentence: string;
  anchor?: Anchor;
  /** 这次查到的释义（回答的结论），复习时用。 */
  sense?: string;
  [key: string]: unknown;
}

/** 折叠后的一个生词。 */
export interface VocabWord {
  word: string;
  display: string;
  /** 查过几次。 */
  count: number;
  firstAt: string;
  lastAt: string;
  /** 最近一次的释义。 */
  sense: string;
  /** 每次查词的原句，按时间先后。 */
  contexts: Array<Pick<VocabRecord, "bookId" | "sourceId" | "sentence" | "at"> & { anchor?: Anchor }>;
}

/** 存取接口。浏览器开发期走 dev bridge，Node 用 @reader/core/node 的 NodeVocabStore，测试用内存实现。 */
export interface VocabStore {
  list(): Promise<VocabRecord[]>;
  append(record: VocabRecord): Promise<void>;
}

/** 词的规整：NFKC、小写、去掉首尾的标点和空白。查词和命中用同一个规整。 */
export function normalizeWord(s: string): string {
  return s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/^[\s\p{P}\p{S}]+|[\s\p{P}\p{S}]+$/gu, "")
    .replace(/\s+/g, " ");
}

/** 能进生词本的选区：1–4 个词、不超过 40 个字符的短文本（整句不算生词）。 */
export function isVocabCandidate(s: string): boolean {
  const w = normalizeWord(s);
  return w.length > 0 && w.length <= 40 && w.split(" ").length <= 4 && !/[.?!;。？！；]/.test(w);
}

export const VOCAB_KEY_ORDER = ["schemaVersion", "word", "display", "at", "bookId", "bookTitle", "sourceId", "sentence", "anchor", "sense"] as const;

export function serializeVocabRecord(r: VocabRecord): string {
  return JSON.stringify(sortKeys(r, VOCAB_KEY_ORDER));
}

/** 解析 jsonl：坏行跳过（不让一行坏数据毁掉整个生词本）。 */
export function parseVocabLines(text: string): VocabRecord[] {
  const out: VocabRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as VocabRecord;
      if (typeof r.word === "string" && r.word && typeof r.at === "string") out.push(r);
    } catch {
      // 跳过坏行
    }
  }
  return out;
}

/** 新建一条查词记录的输入：词规整、时间由这里补。 */
export interface VocabInput {
  display: string;
  bookId: string;
  bookTitle?: string;
  sourceId: string;
  sentence: string;
  anchor?: Anchor;
  sense?: string;
  at?: string;
  [key: string]: unknown;
}

export function makeVocabRecord(input: VocabInput): VocabRecord {
  const { at, ...rest } = input;
  return { ...rest, schemaVersion: SCHEMA_VERSION, word: normalizeWord(input.display), at: at ?? new Date().toISOString() };
}

/** 查词记录 → 生词表，最近查过的在前。 */
export function foldVocab(records: readonly VocabRecord[]): VocabWord[] {
  const map = new Map<string, VocabWord>();
  for (const r of [...records].sort((a, b) => a.at.localeCompare(b.at))) {
    const ctx = { bookId: r.bookId, sourceId: r.sourceId, sentence: r.sentence, at: r.at, ...(r.anchor ? { anchor: r.anchor } : {}) };
    const w = map.get(r.word);
    if (!w) map.set(r.word, { word: r.word, display: r.display, count: 1, firstAt: r.at, lastAt: r.at, sense: r.sense ?? "", contexts: [ctx] });
    else {
      w.count++;
      w.lastAt = r.at;
      w.display = r.display;
      if (r.sense) w.sense = r.sense;
      w.contexts.push(ctx);
    }
  }
  return [...map.values()].sort((a, b) => b.lastAt.localeCompare(a.lastAt));
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * 原文里出现的生词（阅读器点状下划线）。不分大小写；单个英文词放宽到常见词形（-s/-es/-ed/-ing/'s）。
 * 只认完整的词：前后不能是字母数字。
 */
export function findVocab(text: string, words: readonly Pick<VocabWord, "word">[]): Array<{ start: number; end: number; word: string }> {
  if (!words.length) return [];
  const folded = text.normalize("NFKC").toLowerCase();
  // NFKC 可能改变长度：长度变了就不做命中（避免偏移错位），原文是普通英文时不会发生。
  if (folded.length !== text.length) return [];
  const hits: Array<{ start: number; end: number; word: string }> = [];
  for (const { word } of words) {
    const single = /^[a-z]+$/.test(word);
    const body = word.split(" ").map(escapeRe).join("\\s+");
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${body}${single ? "(?:s|es|ed|d|ing|'s)?" : ""}(?![\\p{L}\\p{N}])`, "gu");
    for (const m of folded.matchAll(re)) hits.push({ start: m.index!, end: m.index! + m[0].length, word });
  }
  // 重叠时留先出现、较长的那个。
  hits.sort((a, b) => a.start - b.start || b.end - a.end);
  const out: typeof hits = [];
  for (const h of hits) if (!out.length || h.start >= out.at(-1)!.end) out.push(h);
  return out;
}

/** 内存实现：测试、生产构建（没有 bridge）时的兜底。 */
export class MemoryVocabStore implements VocabStore {
  private lines: string[] = [];
  async list(): Promise<VocabRecord[]> {
    return parseVocabLines(this.lines.join("\n"));
  }
  async append(record: VocabRecord): Promise<void> {
    this.lines.push(serializeVocabRecord(record));
  }
  /** 测试用：看落盘文本。 */
  snapshot(): string {
    return this.lines.map((l) => `${l}\n`).join("");
  }
}

/** reader.vocab：生词本的门面。记录查词、取生词表；生词表缓存到下一次写入。 */
export class Vocab {
  private cache: Promise<VocabWord[]> | null = null;
  constructor(private readonly store: VocabStore) {}

  /** 记一次查词，返回这个词现在的状态（第几次查）。 */
  async add(input: VocabInput): Promise<VocabWord> {
    const rec = makeVocabRecord(input);
    await this.store.append(rec);
    this.cache = null;
    const w = (await this.words()).find((x) => x.word === rec.word);
    return w!;
  }

  async words(): Promise<VocabWord[]> {
    this.cache ??= this.store.list().then(foldVocab);
    return structuredClone(await this.cache);
  }

  async get(display: string): Promise<VocabWord | null> {
    const key = normalizeWord(display);
    return (await this.words()).find((w) => w.word === key) ?? null;
  }
}
