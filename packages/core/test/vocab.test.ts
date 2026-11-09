/** 生词本：规整、折叠、原文命中、jsonl 读写、Node 存储。 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryVocabStore, Reader, MemoryVault, findVocab, foldVocab, isVocabCandidate, makeVocabRecord, normalizeWord, parseVocabLines, serializeVocabRecord } from "../src/index.js";
import { NodeVocabStore } from "../src/node.js";

const rec = (display: string, at: string, sense?: string) =>
  makeVocabRecord({ display, at, bookId: "b", sourceId: "s", sentence: `… ${display} …`, ...(sense ? { sense } : {}) });

describe("normalizeWord / isVocabCandidate", () => {
  it("小写、去首尾标点；整句不算生词", () => {
    expect(normalizeWord(" “Saturating,” ")).toBe("saturating");
    expect(normalizeWord("key  dimension")).toBe("key dimension");
    expect(isVocabCandidate("saturating")).toBe(true);
    expect(isVocabCandidate("dot-product attention")).toBe(true);
    expect(isVocabCandidate("Each score is divided by the root.")).toBe(false);
    expect(isVocabCandidate("a b c d e")).toBe(false);
    expect(isVocabCandidate("…")).toBe(false);
  });
});

describe("foldVocab", () => {
  it("同一个词折成一条：次数、首末时间、最近的释义、每次的原句；最近查的在前", () => {
    const words = foldVocab([rec("Saturating", "2026-11-09T02:00:00Z", "饱和"), rec("ablation", "2026-11-09T01:00:00Z"), rec("saturating", "2026-11-09T00:00:00Z", "旧")]);
    expect(words.map((w) => [w.word, w.count, w.sense])).toEqual([
      ["saturating", 2, "饱和"],
      ["ablation", 1, ""],
    ]);
    expect(words[0]!.firstAt).toBe("2026-11-09T00:00:00Z");
    expect(words[0]!.contexts).toHaveLength(2);
  });
});

describe("findVocab", () => {
  const text = "Softmax saturates. Saturating regions; unsaturating is different. The key  dimension matters.";
  it("整词、不分大小写、常见词形；多词按空白宽松匹配", () => {
    expect(findVocab(text, [{ word: "saturating" }]).map((h) => text.slice(h.start, h.end))).toEqual(["Saturating"]);
    expect(findVocab(text, [{ word: "saturate" }]).map((h) => text.slice(h.start, h.end))).toEqual(["saturates"]);
    expect(findVocab("It saturates and saturated, desaturate.", [{ word: "saturate" }]).length).toBe(2);
    expect(findVocab(text, [{ word: "key dimension" }]).map((h) => text.slice(h.start, h.end))).toEqual(["key  dimension"]);
    expect(findVocab("regions region's", [{ word: "region" }]).length).toBe(2);
  });
});

describe("jsonl", () => {
  it("固定键序，坏行跳过，未知字段保留", () => {
    const line = serializeVocabRecord({ ...rec("ablation", "2026-11-09T00:00:00Z"), zeta: 1 });
    expect(line.indexOf('"schemaVersion"')).toBe(1);
    expect(line.indexOf('"word"')).toBeLessThan(line.indexOf('"display"'));
    const parsed = parseVocabLines(`${line}\n{坏行\n\n{"word":""}\n`);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.zeta).toBe(1);
  });
});

describe("reader.vocab", () => {
  it("add 返回第几次查；words 缓存到下一次写入", async () => {
    const store = new MemoryVocabStore();
    const reader = new Reader(new MemoryVault(), { vocab: store });
    expect((await reader.vocab.add({ display: "Ablation", bookId: "b", sourceId: "s", sentence: "x" })).count).toBe(1);
    expect((await reader.vocab.add({ display: "ablation.", bookId: "b", sourceId: "s", sentence: "y" })).count).toBe(2);
    expect((await reader.vocab.get("ABLATION"))?.contexts.map((c) => c.sentence)).toEqual(["x", "y"]);
    expect(store.snapshot().trim().split("\n")).toHaveLength(2);
  });
});

describe("NodeVocabStore", () => {
  it("追加写 ~/.reader/vocab.jsonl；文件不存在时是空表；并发追加不交错", async () => {
    const home = await mkdtemp(join(tmpdir(), "glossa-vocab-"));
    try {
      const store = new NodeVocabStore(home);
      expect(await store.list()).toEqual([]);
      await Promise.all([store.append(rec("a", "2026-01-01T00:00:00Z")), store.append(rec("b", "2026-01-01T00:00:01Z")), store.append(rec("c", "2026-01-01T00:00:02Z"))]);
      expect((await store.list()).map((r) => r.word)).toEqual(["a", "b", "c"]);
      expect((await readFile(join(home, "vocab.jsonl"), "utf8")).split("\n")).toHaveLength(4);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
