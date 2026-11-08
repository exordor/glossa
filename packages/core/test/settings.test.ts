import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { NodeSettingsStore, readerHome } from "../src/node.js";
import {
  SETTINGS_KEY_ORDER,
  changedSettingsKeys,
  defaultSettings,
  parseSettings,
  serializeSettings,
} from "../src/index.js";

const repoFile = (p: string) => new URL(`../../../${p}`, import.meta.url);
const schema = JSON.parse(readFileSync(repoFile("schemas/settings.schema.json"), "utf8"));
const validate = new Ajv2020({ strict: false, validateFormats: false }).compile(schema);

const sample = () => {
  const s = defaultSettings();
  s.llm.providers["vercel-gateway"] = {
    aliases: { smart: { model: "deepseek/deepseek-v4-pro-0813", reasoning: "high" } },
    routing: { zeroDataRetention: false },
    futureField: { keep: true },
  };
  s.llm.providers.deepseek = { aliases: { vision: null } };
  (s as Record<string, unknown>).theme = { mode: "dark" };
  (s.llm as Record<string, unknown>).zeta = 1;
  return s;
};

describe("settings.json 读写", () => {
  it("键序固定、带 schemaVersion、未知字段保留、往返一致", () => {
    const text = serializeSettings(sample());
    expect(Object.keys(JSON.parse(text))).toEqual([...SETTINGS_KEY_ORDER, "theme"]);
    expect(text.endsWith("\n")).toBe(true);
    const back = parseSettings(text);
    expect(back.schemaVersion).toBe(1);
    expect(back.theme).toEqual({ mode: "dark" });
    expect(back.llm.zeta).toBe(1);
    expect(back.llm.providers["vercel-gateway"]?.futureField).toEqual({ keep: true });
    expect(back.llm.providers.deepseek?.aliases?.vision).toBeNull();
    expect(serializeSettings(back)).toBe(text);
  });

  it("从不写入密钥，并符合 settings.schema.json", () => {
    const s = sample();
    (s.llm.providers.deepseek as Record<string, unknown>).apiKey = "sk-should-not-persist";
    const text = serializeSettings(s);
    expect(text).not.toContain("apiKey");
    expect(text).not.toContain("sk-should-not-persist");
    const ok = validate(JSON.parse(text));
    expect(validate.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
    expect(validate(JSON.parse(serializeSettings(defaultSettings())))).toBe(true);
  });

  it("缺字段补默认值，类型不对换成默认值", () => {
    const s = parseSettings('{"llm":{"activeProvider":5},"onboarding":{"status":"weird"}}');
    expect(s.schemaVersion).toBe(1);
    expect(s.llm.activeProvider).toBe("vercel-gateway");
    expect(s.llm.budget).toEqual({ contextFraction: 0.25, contextTokens: null });
    expect(s.onboarding).toEqual({ status: "pending", updatedAt: null });
    expect(() => parseSettings("[1]")).toThrow();
  });

  it("changedSettingsKeys 给出两层路径", () => {
    const a = sample();
    const b = structuredClone(a);
    b.llm.activeProvider = "deepseek";
    b.onboarding.status = "done";
    expect(changedSettingsKeys(a, b)).toEqual(["llm.activeProvider", "onboarding.status"]);
    expect(changedSettingsKeys(a, structuredClone(a))).toEqual([]);
  });
});

describe("NodeSettingsStore", () => {
  it("READER_HOME 覆盖 ~/.reader", () => {
    expect(readerHome({ READER_HOME: "/x/y" })).toBe("/x/y");
    expect(readerHome({})).toMatch(/\.reader$/);
  });

  it("文件不存在时返回默认值且不写盘；保存后能读回", async () => {
    const home = await mkdtemp(join(tmpdir(), "glossa-home-"));
    const store = new NodeSettingsStore(home);
    expect(await store.load()).toEqual(defaultSettings());
    expect(await readdir(home)).toEqual([]);
    await store.save(sample());
    expect(await readFile(join(home, "settings.json"), "utf8")).toBe(serializeSettings(sample()));
    expect((await store.load()).theme).toEqual({ mode: "dark" });
  });

  it("损坏的 settings.json 备份为 .bak-<时间> 并返回默认值", async () => {
    const home = await mkdtemp(join(tmpdir(), "glossa-home-"));
    await writeFile(join(home, "settings.json"), "{ not json", "utf8");
    const store = new NodeSettingsStore(home);
    expect(await store.load()).toEqual(defaultSettings());
    const files = await readdir(home);
    expect(files.some((f) => f.startsWith("settings.json.bak-"))).toBe(true);
    expect(files).not.toContain("settings.json");
  });
});
