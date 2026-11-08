import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Registry } from "@reader/core";
import { markdownAdapter, registerMarkdownSource } from "../src/index.js";

const chapter = readFileSync(new URL("../../../fixtures/sample-book/01-attention.md", import.meta.url), "utf8");

describe("Markdown 适配器", () => {
  it("通过注册表注册", () => {
    const r = new Registry();
    registerMarkdownSource(r);
    expect(r.get("source", "markdown")).toBe(markdownAdapter);
  });

  it("目录来自标题", async () => {
    const doc = await markdownAdapter.parse("ch1", chapter);
    expect(markdownAdapter.outline(doc).map((h) => h.text)).toEqual([
      "第 1 章 注意力",
      "1.1 为什么需要注意力",
      "1.2 自注意力",
    ]);
  });

  it("选区 → 锚点 → 三层定位：原文不变走第二层，插段后走第一层，改标题后走第三层", async () => {
    const doc = await markdownAdapter.parse("ch1", chapter);
    const phrase = "scaled dot-product attention";
    const start = chapter.indexOf(phrase);
    const anchor = markdownAdapter.selectionToAnchor(doc, { kind: "text", start, end: start + phrase.length });
    expect(anchor.kind).toBe("markdown");
    if (anchor.kind !== "markdown") return;
    expect(anchor.headingPath).toEqual(["第 1 章 注意力", "1.2 自注意力"]);
    expect(anchor.granularity).toBe("phrase");
    expect(markdownAdapter.resolve(doc, anchor)?.layer).toBe(2);

    const inserted = chapter.replace("## 1.2 自注意力\n", "## 1.2 自注意力\n\n新插入的一段。\n");
    const doc2 = await markdownAdapter.parse("ch1", inserted);
    const loc2 = markdownAdapter.resolve(doc2, anchor);
    // 插段使块序号后移，第一层找不到 → 第三层兜底，仍命中正确位置。
    expect(loc2 && inserted.slice(loc2.start, loc2.end)).toBe(phrase);

    const renamed = chapter.replace("ruler", "RULER");
    const doc3 = await markdownAdapter.parse("ch1", renamed);
    const loc3 = markdownAdapter.resolve(doc3, anchor);
    expect(loc3?.layer).toBe(1);
    expect(loc3 && renamed.slice(loc3.start, loc3.end)).toBe(phrase);
  });

  it("对短语提问时 extract 返回 选中 / 所在句 / 所在段 三层", async () => {
    const doc = await markdownAdapter.parse("ch1", chapter);
    const phrase = "scaled dot-product attention";
    const start = chapter.indexOf(phrase);
    const anchor = markdownAdapter.selectionToAnchor(doc, { kind: "text", start, end: start + phrase.length });
    const part = markdownAdapter.extract(doc, anchor);
    expect(part.kind).toBe("text");
    if (part.kind !== "text") return;
    expect(part.selected).toBe(phrase);
    expect(part.sentence).toMatch(/^The Transformer uses scaled dot-product attention/);
    expect(part.sentence!.length).toBeLessThan(part.paragraph!.length);
  });

  it("extract 给出同一小节里前后各最多 2 块（不跨标题）", async () => {
    const doc = await markdownAdapter.parse("ch1", chapter);
    const phrase = "scaled dot-product attention";
    const start = chapter.indexOf(phrase);
    const part = markdownAdapter.extract(doc, markdownAdapter.selectionToAnchor(doc, { kind: "text", start, end: start + phrase.length }));
    if (part.kind !== "text") throw new Error("expected text");
    // 1.2 的第一段：前面是 1.1 的内容，不算；后面是公式和代码块。
    expect(part.before).toBeUndefined();
    expect(part.after?.length).toBe(2);
    expect(part.after?.[0]).toMatch(/^\$\$/);
    expect(part.after?.[1]).toMatch(/^```python/);
  });
});
