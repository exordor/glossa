import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { ActionTemplateError, actionUserMessage, parseActionTemplate } from "../src/index.js";

const ROOT = join(import.meta.dirname, "../../..");
const DIR = join(ROOT, "templates/actions");
const files = readdirSync(DIR).filter((f) => f.endsWith(".md"));
const schema = JSON.parse(readFileSync(join(ROOT, "schemas/action-template.schema.json"), "utf8"));
const validate = new Ajv2020({ strict: false }).compile(schema);

describe("动作模板", () => {
  it("仓库里的模板都能解析，并符合 schema；id 与文件名一致", () => {
    expect(files.sort()).toEqual(["ask.md", "define.md", "explain.md", "note.md", "parse-sentence.md"]);
    for (const f of files) {
      const text = readFileSync(join(DIR, f), "utf8");
      const t = parseActionTemplate(text, f);
      expect(t.id).toBe(f.replace(/\.md$/, ""));
      const fm = parse(/^---\n([\s\S]*?)\n---/.exec(text)![1]!);
      expect(validate(fm), `${f}: ${JSON.stringify(validate.errors)}`).toBe(true);
      if (t.usesLLM) expect(t.prompt.length).toBeGreaterThan(20);
      // 词义、拆句就地弹卡；解释、提问上画布
      expect(t.placement === "inline").toBe(["define", "parse-sentence"].includes(t.id));
    }
  });

  it("字段不合法时报带文件名的错误", () => {
    const bad = (fm: string, body = "提示词") => () => parseActionTemplate(`---\n${fm}\n---\n${body}`, "x.md");
    const ok = "schemaVersion: 1\nid: x\nname: X\nmodel: fast\ninput: [word]\ndepth: brief\nusesLLM: true";
    expect(bad(ok)).not.toThrow();
    expect(bad(ok.replace("model: fast", "model: huge"))).toThrow(/x\.md：model/);
    expect(bad(ok.replace("input: [word]", "input: []"))).toThrow(ActionTemplateError);
    expect(bad(ok.replace("schemaVersion: 1", "schemaVersion: 2"))).toThrow(/schemaVersion/);
    expect(bad(ok, "")).toThrow(/提示词/);
    expect(bad(`${ok}\nplacement: popup`)).toThrow(/placement/);
    expect(parseActionTemplate(`---\n${ok}\nplacement: inline\n---\n提示词`).placement).toBe("inline");
    expect(() => parseActionTemplate("没有 front matter", "y.md")).toThrow(/y\.md：缺少 front matter/);
  });

  it("用户消息按动作的 input 取三层，重复的层省略", () => {
    const define = parseActionTemplate(readFileSync(join(DIR, "define.md"), "utf8"));
    const part = { kind: "text" as const, selected: "saturating", sentence: "It keeps the softmax from saturating.", paragraph: "A. It keeps the softmax from saturating.", headingPath: ["第 1 章", "1.2"] };
    const m = actionUserMessage(define, part);
    expect(m).toContain("【出处】第 1 章 › 1.2");
    expect(m).toContain("【选中】saturating");
    expect(m).toContain("【所在句】It keeps");
    expect(m).toContain("【所在段】A.");
    const same = actionUserMessage(define, { ...part, sentence: "saturating", paragraph: "saturating" });
    expect(same).not.toContain("所在句");
    expect(same).not.toContain("所在段");
  });
});
