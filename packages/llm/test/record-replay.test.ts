import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ProviderSettings, createAppLlm, defaultSettings, MemorySettingsStore } from "@reader/core";
import Ajv2020 from "ajv/dist/2020.js";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import {
  MemoryRecordingStore,
  createLlmClient,
  networkGuardTransport,
  promptHash,
  recordingModeFromEnv,
  registerBuiltinLlmProviders,
} from "../src/index.js";
import { FileRecordingStore, REPO_RECORDINGS_DIR } from "../src/node.js";
import { collect, sampleParts, stable, streamOf } from "./helpers.js";

const schema = JSON.parse(readFileSync(new URL("../../../schemas/recording.schema.json", import.meta.url), "utf8"));
const validate = new Ajv2020({ strict: false, validateFormats: false }).compile(schema);

const settings: ProviderSettings = {
  kind: "test",
  aliases: { fast: { model: "m-fast", reasoning: "none" }, smart: null, vision: null, image: null },
  capabilities: {},
};
const prompt = [{ role: "user", content: [{ type: "text", text: "解释一下" }] }];
const req = { runId: "r", alias: "fast" as const, messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "解释一下" }] }] };

describe("promptHash", () => {
  it("相同请求相同 hash；headers、abortSignal 不影响；模型 id 变则变", async () => {
    const a = await promptHash("m", { prompt, maxOutputTokens: 100 });
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await promptHash("m", { prompt, maxOutputTokens: 100, headers: { x: "1" }, abortSignal: new AbortController().signal })).toBe(a);
    expect(await promptHash("m2", { prompt, maxOutputTokens: 100 })).not.toBe(a);
    expect(await promptHash("m", { prompt, maxOutputTokens: 101 })).not.toBe(a);
  });

  it("vitest 下默认 replay", () => {
    expect(recordingModeFromEnv()).toBe("replay");
    expect(recordingModeFromEnv({})).toBe("off");
  });
});

describe("录制回放", () => {
  it("录制后回放与原始流一致；回放不调用模型", async () => {
    const store = new MemoryRecordingStore();
    const live = new MockLanguageModelV4({ modelId: "m-fast", doStream: async () => streamOf(sampleParts()) });
    const rec = createLlmClient({ providerId: "test", settings, languageModel: () => live, recordings: { mode: "record", store } });
    const original = await collect(rec.stream(req, new AbortController().signal));
    expect(store.items.size).toBe(1);

    const dead = new MockLanguageModelV4({
      modelId: "m-fast",
      doStream: async () => {
        throw new Error("回放时不该调用模型");
      },
    });
    const rep = createLlmClient({ providerId: "test", settings, languageModel: () => dead, recordings: { mode: "replay", store } });
    const replayed = await collect(rep.stream(req, new AbortController().signal));
    expect(stable(replayed)).toEqual(stable(original));
    expect(dead.doStreamCalls).toHaveLength(0);
  });

  it("未命中 → replay_miss，并给出 hash", async () => {
    const model = new MockLanguageModelV4({ modelId: "m-fast", doStream: async () => streamOf(sampleParts()) });
    const client = createLlmClient({ providerId: "test", settings, languageModel: () => model, recordings: { mode: "replay", store: new MemoryRecordingStore() } });
    const chunks = await collect(client.stream(req, new AbortController().signal));
    expect(chunks.at(-1)).toMatchObject({ type: "error", error: { code: "replay_miss" } });
    expect(JSON.stringify(chunks.at(-1))).toMatch(/[0-9a-f]{64}\.json/);
    expect(model.doStreamCalls).toHaveLength(0);
  });

  it("record 模式写出的文件符合 recording.schema.json", async () => {
    const dir = await mkdtemp(join(tmpdir(), "glossa-rec-"));
    const model = new MockLanguageModelV4({ modelId: "m-fast", doStream: async () => streamOf(sampleParts()) });
    const client = createLlmClient({
      providerId: "test",
      settings,
      languageModel: () => model,
      recordings: { mode: "record", store: new FileRecordingStore(dir), now: () => "2026-11-08T00:00:00.000Z" },
    });
    await collect(client.stream(req, new AbortController().signal));
    const files = await readdir(dir);
    expect(files).toHaveLength(1);
    const text = await readFile(join(dir, files[0]!), "utf8");
    const json = JSON.parse(text);
    expect(validate(json)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    expect(Object.keys(json).slice(0, 4)).toEqual(["schemaVersion", "promptHash", "modelId", "kind"]);
    expect(files[0]).toBe(`${json.promptHash}.json`);
  });

  it("仓库里的一键测试录制：vercel-gateway 回放，不联网", async () => {
    const app = createAppLlm({ settings: new MemorySettingsStore(defaultSettings()) });
    registerBuiltinLlmProviders(app.registry, {
      transport: networkGuardTransport(),
      recordings: { mode: "replay", store: new FileRecordingStore(REPO_RECORDINGS_DIR) },
    });
    const chunks = await collect(app.llm.test("fast"));
    expect(chunks[0]).toMatchObject({ type: "start", providerId: "vercel-gateway", modelId: "deepseek/deepseek-v4.1-flash-1017" });
    expect(chunks.at(-1)).toMatchObject({ type: "finish", finishReason: "stop" });
    const text = chunks.flatMap((c) => (c.type === "text" ? [c.delta] : [])).join("");
    expect(text).toContain("DeepSeek");
    for (const f of await readdir(REPO_RECORDINGS_DIR)) {
      if (f.endsWith(".json")) expect(validate(JSON.parse(await readFile(join(REPO_RECORDINGS_DIR, f), "utf8")))).toBe(true);
    }
  });
});
