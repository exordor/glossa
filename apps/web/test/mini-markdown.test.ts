import { describe, expect, it } from "vitest";
import { blocks, compactText } from "../src/mini-markdown-text";

describe("回答文字的极简 Markdown", () => {
  it("卡片：去掉标题井号，列表换成圆点，保留换行", () => {
    expect(compactText("## 结论\n- 第一点\n* 第二点\n\n\n\n尾")).toBe("结论\n• 第一点\n• 第二点\n\n尾");
  });
  it("就地卡：段落、无序、有序列表分块", () => {
    const b = blocks("一句话结论。\n\n1. 主干\n2. 修饰\n- a\n- b\n正文\n续行");
    expect(b.map((x) => x.kind)).toEqual(["p", "ol", "ul", "p"]);
    expect(b[1]).toMatchObject({ items: ["主干", "修饰"], start: 1 });
    expect(b[3]).toMatchObject({ text: "正文\n续行" });
  });
});
