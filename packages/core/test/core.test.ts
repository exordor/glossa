import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  EVENT_NAMES,
  EXTENSION_POINTS,
  EventBus,
  Registry,
  containmentParents,
  findQuote,
  makeQuote,
} from "../src/index.js";

const repoFile = (p: string) => new URL(`../../../${p}`, import.meta.url);

describe("事件名与 schemas/events.json 一致", () => {
  it("名字和顺序完全相同", () => {
    const schema = JSON.parse(readFileSync(repoFile("schemas/events.json"), "utf8")) as {
      events: Array<{ name: string }>;
    };
    expect(schema.events.map((e) => e.name)).toEqual([...EVENT_NAMES]);
  });

  it("负载被结构化克隆，订阅者改不到发送方对象", () => {
    const bus = new EventBus();
    const payload = { sourceId: "s", path: "a.md", hash: "h" };
    bus.on("source.changed", (p) => {
      p.path = "changed";
    });
    bus.emit("source.changed", payload);
    expect(payload.path).toBe("a.md");
  });
});

describe("注册表", () => {
  it("插件 manifest schema 的扩展点枚举和注册表一致", () => {
    const schema = JSON.parse(readFileSync(repoFile("schemas/plugin-manifest.schema.json"), "utf8"));
    expect(schema.$defs.extensionPoint.enum).toEqual([...EXTENSION_POINTS]);
  });

  it("注册、列出、同名拒绝、撤销", () => {
    const r = new Registry();
    const reg = r.register("panel", { id: "source", title: "原文", component: "SourcePanel" });
    expect(r.list("panel").map((p) => p.id)).toEqual(["source"]);
    expect(r.ownerOf("panel", "source")).toBe("builtin");
    expect(() => r.register("panel", { id: "source", title: "x", component: "x" }, "plugin:foo")).toThrow();
    reg.dispose();
    expect(r.list("panel")).toEqual([]);
  });
});

describe("批注包含树", () => {
  it("段落 ⊃ 句子 ⊃ 短语；交叉为兄弟；完全相同为兄弟", () => {
    const s = "src";
    const parents = containmentParents([
      { id: "phrase", sourceId: s, start: 12, end: 18 },
      { id: "para", sourceId: s, start: 0, end: 100 },
      { id: "sent", sourceId: s, start: 10, end: 40 },
      { id: "cross", sourceId: s, start: 30, end: 60 },
      { id: "sent-dup", sourceId: s, start: 10, end: 40, createdAt: "z" },
      { id: "other-src", sourceId: "b", start: 12, end: 18 },
    ]);
    expect(parents.get("para")).toBeNull();
    expect(parents.get("sent")).toBe("para");
    expect(parents.get("sent-dup")).toBe("para");
    expect(parents.get("phrase")).toBe("sent-dup");
    expect(parents.get("cross")).toBe("para");
    expect(parents.get("other-src")).toBeNull();
  });
});

describe("引文定位", () => {
  it("exact 出现多次时用前后文消歧", () => {
    const text = "the model uses attention here. later, self attention is defined.";
    const second = text.lastIndexOf("attention");
    const q = makeQuote(text, second, second + "attention".length);
    const edited = "INSERTED. " + text;
    expect(findQuote(edited, q)).toEqual({ start: second + 10, end: second + 10 + 9 });
  });
});
