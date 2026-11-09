import { describe, expect, it } from "vitest";
import { paragraphEntries, queryTerms, search } from "../src/index.js";

const text = "# 第 1 章\n\n## 1.2 自注意力\n\nThe Transformer uses scaled dot-product attention.\nEach score is divided.\n\n公式里的 softmax 会饱和。";

describe("搜索", () => {
  const entries = [
    ...paragraphEntries("s1", "第 1 章", text),
    { kind: "node" as const, id: "a1", title: "回答", text: "缩放是为了防止 softmax 饱和" },
  ];

  it("段落条目带偏移和出处", () => {
    const p = entries.find((e) => e.text.startsWith("The Transformer"))!;
    expect(p).toMatchObject({ kind: "source", id: "s1", title: "第 1 章 › 1.2 自注意力" });
    expect(text.slice(p.start!, p.start! + 15)).toBe("The Transformer");
  });

  it("所有词都要出现；大小写、全半角不敏感；卡片略优先", () => {
    expect(queryTerms("  Softmax   饱和 ")).toEqual(["softmax", "饱和"]);
    const hits = search("SOFTMAX 饱和", entries);
    expect(hits.map((h) => h.entry.id)).toEqual(["a1", "s1"]);
    expect(search("softmax attention", entries)).toEqual([]);
  });

  it("片段围绕第一个命中，mark 指向片段里的命中", () => {
    const [h] = search("dot-product", entries);
    expect(h!.snippet.slice(h!.mark[0], h!.mark[1]).toLowerCase()).toBe("dot-product");
    expect(h!.snippet).not.toContain("\n");
    expect(search("", entries)).toEqual([]);
  });
});
