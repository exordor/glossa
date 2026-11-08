import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import { actionInstructions, citationsOf, isQuoteInSources, parseActionTemplate, parseAnswer, verifyCitations } from "../src/index.js";

const SOURCE = `## 3.2 Attention

An attention function can be described as **mapping a query** and a set of key-value pairs to an output,
where the query, keys, values, and output are all vectors.`;

describe("parseAnswer", () => {
  it("第一行是结论，无序列表是要点", () => {
    const a = parseAnswer("注意力把查询和键值对映射成输出。\n\n- 查询、键、值都是向量\n- 输出是值的加权和\n  权重来自查询和键", "points");
    expect(a.summary).toBe("注意力把查询和键值对映射成输出。");
    expect(a.points).toEqual(["查询、键、值都是向量", "输出是值的加权和 权重来自查询和键"]);
    expect(a.steps).toBeUndefined();
  });

  it("有序列表是步骤", () => {
    const a = parseAnswer("这句话的骨架很简单。\n1. 主干：function can be described\n2. 修饰：as mapping…", "steps");
    expect(a.steps).toEqual(["主干：function can be described", "修饰：as mapping…"]);
  });

  it("去掉模型自己加的「结论：」标签和标题符号", () => {
    expect(parseAnswer("**结论：** 它是一个映射。", "brief").summary).toBe("它是一个映射。");
    expect(parseAnswer("一句话结论：它是一个映射。", "brief").summary).toBe("它是一个映射。");
    expect(parseAnswer("## 它是一个映射", "brief").summary).toBe("它是一个映射");
  });

  it("半截文字也能解析（流式）", () => {
    expect(parseAnswer("注意力把查询", "points")).toMatchObject({ summary: "注意力把查询", citations: [] });
    expect(parseAnswer("结论。\n\n- 第一", "points").points).toEqual(["第一"]);
  });

  it("直接从列表开始时没有结论", () => {
    expect(parseAnswer("- a\n- b", "points")).toMatchObject({ summary: "", points: ["a", "b"] });
  });
});

describe("引用校验", () => {
  it("取出「」和“”里的原话，去重", () => {
    expect(citationsOf("原文说「mapping a query」，又说「mapping a query」和“all vectors here”，「x」太短")).toEqual([
      "mapping a query",
      "all vectors here",
    ]);
  });

  it("忽略大小写、空白、Markdown 记号和首尾标点", () => {
    expect(isQuoteInSources("An attention function can be described as mapping a query,", [SOURCE])).toBe(true);
    expect(isQuoteInSources("keys,   values, and OUTPUT are all vectors.", [SOURCE])).toBe(true);
  });

  it("允许省略号跳过中间，但顺序要对", () => {
    expect(isQuoteInSources("An attention function … are all vectors", [SOURCE])).toBe(true);
    expect(isQuoteInSources("are all vectors … An attention function", [SOURCE])).toBe(false);
  });

  it("改写过的句子标为未找到", () => {
    const c = verifyCitations("原文说「mapping a query」，还说「attention maps queries to outputs」", [SOURCE]);
    expect(c).toEqual([
      { quote: "mapping a query", verified: true },
      { quote: "attention maps queries to outputs", verified: false },
    ]);
  });

  it("parseAnswer 给了原文就校验", () => {
    expect(parseAnswer("它是「a set of key-value pairs」的映射。", "brief", [SOURCE]).citations).toEqual([
      { quote: "a set of key-value pairs", verified: true },
    ]);
  });
});

describe("actionInstructions", () => {
  const t = parseActionTemplate(readFileSync(new URL("../../../templates/actions/explain.md", import.meta.url), "utf8"), "explain.md");

  it("模板提示词后面接统一的输出格式，深度可以覆盖", () => {
    const own = actionInstructions(t);
    expect(own.startsWith(t.prompt)).toBe(true);
    expect(own).toContain("「- 」开头的要点");
    const brief = actionInstructions(t, "brief");
    expect(brief).toContain("只写一句话结论");
    expect(brief).not.toContain("「- 」开头的要点");
    expect(actionInstructions(t, "steps")).toContain("「1. 」");
  });
});

describe("node-meta schema", () => {
  it("接受 depth 和 citations", () => {
    const schema = JSON.parse(readFileSync(new URL("../../../schemas/node-meta.schema.json", import.meta.url), "utf8"));
    const validate = new Ajv2020({ strict: false }).compile(schema);
    const meta = {
      schemaVersion: 1,
      type: "answer",
      status: "done",
      createdBy: "ai",
      createdAt: "2026-11-08T00:00:00.000Z",
      depth: "points",
      citations: [{ quote: "mapping a query", verified: true }],
    };
    expect(validate(meta)).toBe(true);
    expect(validate({ ...meta, depth: "long" })).toBe(false);
  });
});
