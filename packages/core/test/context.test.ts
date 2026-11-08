import { describe, expect, it } from "vitest";
import { type ActionTemplate, type ContextInput, assembleContext, estimateTextTokens } from "../src/index.js";

const action: ActionTemplate = { id: "explain", name: "解释", model: "smart", input: ["sentence", "passage"], depth: "points", usesLLM: true, prompt: "解释【选中】。" };
const long = (n: number) => "注".repeat(n);

const base = (over: Partial<ContextInput> = {}): ContextInput => ({
  action,
  book: { title: "示例书", authors: ["A"] },
  chapter: "第 1 章 注意力",
  chapterSummary: "本章讲注意力。",
  excerpts: [
    {
      nodeId: "x1",
      headingPath: ["第 1 章 注意力", "1.2 自注意力"],
      selected: "scaled dot-product attention",
      sentence: "The Transformer uses scaled dot-product attention.",
      paragraph: "The Transformer uses scaled dot-product attention. Each score is divided.",
      before: ["前一段", "紧挨着的前一段"],
      after: ["紧挨着的后一段", "后一段"],
    },
  ],
  conversation: [
    { question: "解释「a」", answer: "旧回答结论\n\n- 旧要点", summary: "旧回答结论" },
    { question: "解释「b」", answer: "新回答结论\n\n- 新要点", summary: "新回答结论" },
  ],
  notes: [1, 2, 3, 4].map((i) => ({ text: `想法${i}`, quote: "q" })),
  question: "为什么要除以根号 d？",
  budget: 100_000,
  ...over,
});

describe("assembleContext", () => {
  it("7 项固定顺序：系统提示词进 instructions，其余按位置拼进用户消息", () => {
    const c = assembleContext(base());
    expect(c.items.map((i) => i.id)).toEqual(["system", "summary", "e1", "around-e1", "qa-1", "qa-2", "note-1", "note-2", "note-3", "note-4", "question"]);
    expect(c.items.map((i) => i.position)).toEqual([1, 2, 3, 4, 5, 5, 6, 6, 6, 6, 7]);
    expect(c.instructions.startsWith("解释【选中】。")).toBe(true);
    expect(c.instructions).toContain("书名：示例书（A）");
    expect(c.instructions).toContain("当前章节：第 1 章 注意力");
    const order = ["【本章摘要】", "【摘录 e1】", "【出处】第 1 章 注意力 › 1.2 自注意力", "【所在句】", "【摘录 e1 周边原文】", "【之前的问答 1】", "【之前的问答 2】", "【读者的想法】", "【问题】为什么要除以根号 d？"];
    const at = order.map((k) => c.message.indexOf(k));
    expect(at.every((x) => x >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(c).toMatchObject({ compressed: false, overBudget: false });
    expect(c.tokens).toBe(c.items.reduce((n, i) => n + i.tokens, 0));
    expect(structuredClone(c)).toEqual(c);
  });

  it("超预算按优先级逐级压缩，够了就停", () => {
    const full = assembleContext(base()).tokens;
    const summaryTokens = assembleContext(base()).items.find((i) => i.id === "summary")!.tokens;
    // 只超一点：只去掉本章摘要
    const c1 = assembleContext(base({ budget: full - 1 }));
    expect(c1.items.find((i) => i.id === "summary")?.compressed).toBe("dropped");
    expect(c1.items.find((i) => i.id === "around-e1")?.compressed).toBeUndefined();
    expect(c1.message).not.toContain("【本章摘要】");
    expect(c1.tokens).toBe(full - summaryTokens);
    // 预算很小：周边缩到前后各 1 段，远的问答只留结论，批注只留最近 3 条，仍超就标 overBudget
    const c2 = assembleContext(base({ budget: 10 }));
    const around = c2.items.find((i) => i.id === "around-e1")!;
    expect(around.compressed).toBe("shortened");
    expect(around.text).toContain("紧挨着的前一段");
    expect(around.text).not.toContain("\n前一段");
    expect(c2.items.find((i) => i.id === "qa-1")).toMatchObject({ compressed: "summarized" });
    expect(c2.message).not.toContain("旧要点");
    expect(c2.message).toContain("新要点");
    expect(c2.items.filter((i) => i.kind === "note" && i.compressed === "dropped").map((i) => i.id)).toEqual(["note-1"]);
    expect(c2.overBudget).toBe(true);
    expect(c2.compressed).toBe(true);
  });

  it("用户去掉的项不发送；系统提示词和问题去不掉", () => {
    const c = assembleContext(base({ exclude: ["around-e1", "note-2", "system", "question"] }));
    expect(c.message).not.toContain("周边原文");
    expect(c.message).not.toContain("想法2");
    expect(c.message).toContain("【问题】");
    expect(c.items.filter((i) => i.excluded).map((i) => i.id)).toEqual(["around-e1", "note-2"]);
  });

  it("没有的项不出现；token 粗估中文 1 字 1 个，英文 4 字符 1 个", () => {
    const c = assembleContext(base({ chapterSummary: undefined, conversation: [], notes: [], question: undefined }));
    expect(c.items.map((i) => i.kind)).toEqual(["system", "excerpt", "around"]);
    expect(estimateTextTokens(long(10))).toBe(10);
    expect(estimateTextTokens("abcdefgh")).toBe(2);
  });
});
