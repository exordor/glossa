import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import {
  type ActionTemplate,
  Journal,
  MemoryVault,
  RUNS_DIR,
  STATS_FILE,
  assembleContext,
  buildRunRecord,
  summarizeStats,
} from "../src/index.js";

const schema = (name: string) =>
  new Ajv2020({ strict: false }).compile(JSON.parse(readFileSync(new URL(`../../../schemas/${name}`, import.meta.url), "utf8")));
const action: ActionTemplate = { id: "explain", name: "解释", model: "smart", input: ["passage"], depth: "points", usesLLM: true, prompt: "解释。" };
const ctx = assembleContext({ action, book: { title: "书" }, excerpts: [{ nodeId: "x1", headingPath: ["1"], selected: "选中" }], budget: 1000, exclude: [] });

const run = (over: Partial<Parameters<typeof buildRunRecord>[0]> = {}) =>
  buildRunRecord({
    runId: "r1",
    nodeId: "a1",
    actionId: "explain",
    actionPrompt: action.prompt,
    depth: "points",
    placement: "canvas",
    providerId: "deepseek",
    alias: "smart",
    modelId: "deepseek-chat",
    context: ctx,
    output: '{"summary":"s"}',
    structured: true,
    ok: true,
    usage: { inputTokens: 1000, outputTokens: 500 },
    firstChunkMs: 800,
    durationMs: 2000,
    pricing: { inputPerMTok: 0.27, outputPerMTok: 1.1 },
    citations: [
      { quote: "a", verified: true },
      { quote: "b", verified: false },
    ],
    at: "2026-11-08T23:00:00.000Z",
    ...over,
  });

describe("运行记录", () => {
  it("拼出完整记录：上下文各项来源与 token、完整提示词、hash、费用、引用错误数", () => {
    const r = run();
    expect(r.context.items.map((i) => [i.id, i.nodeId])).toEqual([["system", undefined], ["e1", "x1"]]);
    expect(r.prompt).toEqual({ instructions: ctx.instructions, message: ctx.message });
    expect(r.promptHash).toMatch(/^[0-9a-f]+$/);
    expect(r.costUsd).toBeCloseTo((1000 * 0.27 + 500 * 1.1) / 1e6, 9);
    expect(r.citationErrors).toBe(1);
    expect(schema("run.schema.json")(r)).toBe(true);
    // 相同输入 → 相同 cacheKey；换模型就变
    expect(run().cacheKey).toBe(r.cacheKey);
    expect(run({ modelId: "deepseek-reasoner" }).cacheKey).not.toBe(r.cacheKey);
  });

  it("单价未知时不写费用；失败记录错误码", () => {
    const r = run({ pricing: null, ok: false, error: "timeout" });
    expect(r.costUsd).toBeUndefined();
    expect(r).toMatchObject({ ok: false, error: "timeout" });
    expect(schema("run.schema.json")(r)).toBe(true);
  });

  it("按天追加写 jsonl，键顺序固定；并发写不丢行；坏行跳过", async () => {
    const vault = new MemoryVault();
    const j = new Journal(vault);
    await Promise.all([j.recordRun(run({ runId: "r1" })), j.recordRun(run({ runId: "r2" })), j.recordRun(run({ runId: "r3" }))]);
    const path = `${RUNS_DIR}/2026-11-08.jsonl`;
    const lines = vault.files.get(path)!.trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(Object.keys(JSON.parse(lines[0]!)).slice(0, 4)).toEqual(["schemaVersion", "runId", "at", "nodeId"]);
    vault.files.set(path, vault.files.get(path)! + "{坏行\n");
    expect((await j.listRuns("2026-11-08")).map((r) => r.runId)).toEqual(["r1", "r2", "r3"]);
  });
});

describe("使用统计", () => {
  it("写 stats.jsonl 并算出 v0.1 出口指标", async () => {
    const vault = new MemoryVault();
    const j = new Journal(vault);
    await j.recordStat({ event: "action", actionId: "explain", placement: "canvas", followup: false });
    await j.recordStat({ event: "action", actionId: "ask", placement: "canvas", followup: true });
    await j.recordStat({ event: "action", actionId: "define", placement: "inline", followup: false });
    await j.recordStat({ event: "first-token", actionId: "explain", ms: 1200 });
    await j.recordStat({ event: "first-token", actionId: "ask", ms: 2600 });
    await j.recordStat({ event: "locate", nodeId: "n1", sourceId: "s1" });
    const stats = await j.listStats();
    expect(vault.files.get(STATS_FILE)!.split("\n")[0]).toMatch(/^\{"schemaVersion":1,"at":"[^"]+","event":"action"/);
    const v = schema("stat.schema.json");
    expect(stats.every((s) => v(s))).toBe(true);
    expect(summarizeStats(stats)).toEqual({ actions: 3, followups: 1, followupRate: 1 / 3, locates: 1, firstTokenMedianMs: 1900 });
  });
});
