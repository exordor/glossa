import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Element, Root } from "hast";
import { markdownAdapter } from "../src/index.js";
import { renderToHast, resolveRelative } from "../src/render.js";

const chapter = readFileSync(new URL("../../../fixtures/sample-book/01-attention.md", import.meta.url), "utf8");

function find(node: Root | Element, pred: (e: Element) => boolean, out: Element[] = []): Element[] {
  for (const c of node.children) {
    if (c.type === "element") {
      if (pred(c)) out.push(c);
      find(c, pred, out);
    }
  }
  return out;
}

describe("阅读器渲染", () => {
  it("图片按章节目录解析，公式由 KaTeX 渲染，代码块保留", async () => {
    const doc = await markdownAdapter.parse("ch1", chapter);
    const seen: string[] = [];
    const hast = await renderToHast(doc, {
      resolveAsset: (src) => {
        seen.push(src);
        const p = resolveRelative("01-attention.md", src);
        return p ? `/book/${p}` : null;
      },
    });
    const img = find(hast, (e) => e.tagName === "img")[0]!;
    expect(seen).toEqual(["images/attention-weights.svg"]);
    expect(img.properties.src).toBe("/book/images/attention-weights.svg");
    expect(img.properties.alt).toBe("注意力权重示意图");
    const fig = find(hast, (e) => e.tagName === "figure")[0]!;
    expect(find(fig, (e) => e.tagName === "figcaption")).toHaveLength(1);
    expect(find(hast, (e) => (e.properties.className as string[] | undefined)?.includes("katex-display") ?? false)).toHaveLength(1);
    expect(find(hast, (e) => e.tagName === "pre")).toHaveLength(1);
  });

  it("每个文字 span 的 data-s / data-e 正好对应源文件里的同一段文字", async () => {
    const doc = await markdownAdapter.parse("ch1", chapter);
    const spans = find(await renderToHast(doc), (e) => e.tagName === "span" && e.properties.dataS !== undefined);
    expect(spans.length).toBeGreaterThanOrEqual(5);
    for (const s of spans) {
      const text = s.children.map((c) => (c.type === "text" ? c.value : "")).join("");
      const slice = chapter.slice(Number(s.properties.dataS), Number(s.properties.dataE));
      // 带转义或实体的文字源码与显示不同，这里的夹具没有，所以必须完全相等。
      expect(slice).toBe(text);
    }
  });

  it("相对路径解析", () => {
    expect(resolveRelative("part1/ch2.md", "../img/a.png")).toBe("img/a.png");
    expect(resolveRelative("ch.md", "./a%20b.png")).toBe("a b.png");
    expect(resolveRelative("ch.md", "../../x.png")).toBeNull();
    expect(resolveRelative("ch.md", "https://x/y.png")).toBeNull();
  });
});
