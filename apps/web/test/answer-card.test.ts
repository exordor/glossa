import { describe, expect, it } from "vitest";
import type { ReaderNode } from "@reader/core";
import { answerParts } from "../src/answer-card";
import { citeSummary } from "../src/cite";

const answer = (text: string, extra: Partial<ReaderNode["meta"]> = {}): ReaderNode => ({
  id: "n1",
  x: 0,
  y: 0,
  width: 360,
  height: 148,
  text,
  meta: { schemaVersion: 1, type: "answer", status: "done", createdBy: "ai", createdAt: "2026-11-08T00:00:00.000Z", ...extra },
});

describe("回答卡显示", () => {
  it("结论做标题（去掉加粗记号），要点做正文", () => {
    const p = answerParts(answer("**注意力**是一个映射。\n\n- 查询和键算权重\n- 对值加权求和", { depth: "points" }));
    expect(p.title).toBe("注意力是一个映射。");
    expect(p.body).toBe("- 查询和键算权重\n- 对值加权求和");
  });

  it("步骤保留编号", () => {
    const p = answerParts(answer("骨架很简单。\n1. 主干\n2. 修饰", { depth: "steps" }));
    expect(p.body).toBe("1. 主干\n2. 修饰");
  });

  it("失败的卡照原文显示", () => {
    const p = answerParts(answer("一半\n\n（中断：网络不可用）", { status: "failed" }));
    expect(p).toMatchObject({ title: "", body: "一半\n\n（中断：网络不可用）" });
  });

  it("底部显示引用校验", () => {
    const p = answerParts(
      answer("它是「a」的映射。", {
        citations: [
          { quote: "mapping a query", verified: true },
          { quote: "maps queries", verified: false },
        ],
      }),
    );
    expect(p).toMatchObject({ cite: "1 处引用在原文里没找到", citeWarn: true });
  });
});

describe("citeSummary", () => {
  it("没有引用不显示；全部找到不警告", () => {
    expect(citeSummary([])).toBeNull();
    expect(citeSummary([{ quote: "x y", verified: true }])).toMatchObject({ short: "引用 1 处，均已核对原文", warn: false });
  });
});
