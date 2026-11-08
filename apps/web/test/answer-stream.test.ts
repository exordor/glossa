import { describe, expect, it } from "vitest";
import { AnswerAccumulator } from "../src/answer-stream";

const SRC = ["Each score is divided by the square root of the key dimension, which keeps the softmax from saturating."];

describe("AnswerAccumulator", () => {
  it("结构化：原始 JSON 不显示，半截对象显示为 Markdown，结束时校验引用", () => {
    const a = new AnswerAccumulator("points");
    expect(a.push({ type: "text", delta: '{"summary":"缩' })).toBe(true);
    expect(a.display()).toBe("");
    a.push({ type: "object", value: { summary: "缩" }, final: false });
    expect(a.display()).toBe("缩");
    expect(a.push({ type: "text", delta: "放" })).toBe(false);
    a.push({ type: "object", value: { summary: "缩放防止饱和", points: ["原文「keeps the softmax from saturating」"], citations: [{ quote: "softmax never saturates" }] }, final: true });
    expect(a.finish(SRC)).toEqual({
      text: "缩放防止饱和\n\n- 原文「keeps the softmax from saturating」",
      citations: [
        { quote: "softmax never saturates", verified: false },
        { quote: "keeps the softmax from saturating", verified: true },
      ],
    });
  });

  it("模型没给 JSON：直接显示文字，结束时按文字解析引用", () => {
    const a = new AnswerAccumulator("points");
    a.push({ type: "text", delta: "缩放防止饱和。\n- 原文「keeps the softmax from saturating」" });
    expect(a.display()).toContain("缩放防止饱和");
    expect(a.finish(SRC).citations).toEqual([{ quote: "keeps the softmax from saturating", verified: true }]);
  });
});
