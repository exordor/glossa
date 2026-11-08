/**
 * 录制回放（CLAUDE.md：LLM 调用在测试里全部走录制回放，按 promptHash 存 fixtures/recordings/，测试不花钱）。
 * 做成 LanguageModelMiddleware，套在任何 provider 的模型外面，和服务商无关。
 *
 * 模式来自环境变量 GLOSSA_LLM_RECORDINGS：
 *   replay  vitest 默认（vitest.config.ts 里设置）：命中则回放，未命中报 replay_miss。
 *   record  手动录制：真实联网，把结果写成 <promptHash>.json。
 *   off     应用默认：直接透传。
 */
import { stableStringify } from "@reader/core";
import { type LanguageModelMiddleware, simulateReadableStream } from "ai";

export type RecordingMode = "off" | "replay" | "record";

export function recordingModeFromEnv(env?: Record<string, string | undefined>): RecordingMode {
  const e = env ?? (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
  const v = e.GLOSSA_LLM_RECORDINGS;
  return v === "replay" || v === "record" ? v : "off";
}

/** fixtures/recordings/<promptHash>.json 的内容，schema 见 schemas/recording.schema.json。 */
export interface Recording {
  schemaVersion: 1;
  promptHash: string;
  modelId: string;
  kind: "stream" | "generate";
  recordedAt: string;
  request: Record<string, unknown>;
  /** kind 为 stream：LanguageModelV4StreamPart 序列（日期存 ISO 字符串）。 */
  parts?: unknown[];
  /** kind 为 generate：doGenerate 的结果。 */
  result?: unknown;
}

export const RECORDING_KEY_ORDER = ["schemaVersion", "promptHash", "modelId", "kind", "recordedAt", "request", "parts", "result"];

export interface RecordingStore {
  get(promptHash: string): Promise<Recording | null>;
  put(rec: Recording): Promise<void>;
}

export class MemoryRecordingStore implements RecordingStore {
  readonly items = new Map<string, Recording>();
  async get(h: string) {
    const r = this.items.get(h);
    return r ? structuredClone(r) : null;
  }
  async put(rec: Recording) {
    this.items.set(rec.promptHash, structuredClone(rec));
  }
}

export class ReplayMissError extends Error {
  override readonly name = "ReplayMissError";
  constructor(readonly promptHash: string) {
    super(`没有录制：fixtures/recordings/${promptHash}.json（用 GLOSSA_LLM_RECORDINGS=record 录制）`);
  }
}

/** 转成可 JSON 化的值：Date → ISO，字节 → { $bytes: base64 }，URL → href，函数和 undefined 去掉。 */
export function toJsonSafe(v: unknown): unknown {
  if (v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
  if (v instanceof Date) return v.toISOString();
  if (v instanceof URL) return v.href;
  if (v instanceof Uint8Array) return { $bytes: bytesToBase64(v) };
  if (v instanceof Error) return { name: v.name, message: v.message };
  if (Array.isArray(v)) return v.map((x) => (x === undefined ? null : toJsonSafe(x)));
  if (typeof v === "object") {
    if (typeof (v as { getReader?: unknown }).getReader === "function") return undefined; // AbortSignal、流之类不进 hash
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      const j = toJsonSafe(x);
      if (j !== undefined) out[k] = j;
    }
    return out;
  }
  return undefined;
}

function bytesToBase64(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

async function sha256hex(text: string): Promise<string> {
  const d = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** 参与 hash 的调用参数。abortSignal、headers 等不影响输出的字段不算。 */
export function hashInput(modelId: string, params: Record<string, unknown>): Record<string, unknown> {
  const { prompt, maxOutputTokens, temperature, reasoning, responseFormat, tools, providerOptions } = params;
  return toJsonSafe({ modelId, prompt, maxOutputTokens, temperature, reasoning, responseFormat, tools, providerOptions }) as Record<string, unknown>;
}

/** promptHash = sha256(stableStringify(hashInput))，十六进制。步骤 7 的 runs 记录用同一个值。 */
export async function promptHash(modelId: string, params: Record<string, unknown>): Promise<string> {
  return sha256hex(stableStringify(hashInput(modelId, params)));
}

/** 回放时把 ISO 字符串的 timestamp 还原成 Date（SDK 期望 Date）。 */
function revivePart(p: unknown): unknown {
  if (typeof p !== "object" || p === null) return p;
  const o = { ...(p as Record<string, unknown>) };
  if (typeof o.timestamp === "string") o.timestamp = new Date(o.timestamp);
  if (o.type === "error" && typeof o.error === "object" && o.error !== null) {
    const e = o.error as { name?: string; message?: string };
    const err = new Error(e.message ?? "录制的错误");
    if (e.name) err.name = e.name;
    o.error = err;
  }
  return o;
}

function reviveResult(r: unknown): unknown {
  if (typeof r !== "object" || r === null) return r;
  const o = { ...(r as Record<string, unknown>) };
  if (typeof o.response === "object" && o.response !== null) o.response = revivePart(o.response);
  return o;
}

export interface RecordReplayOptions {
  mode: RecordingMode;
  store?: RecordingStore;
  /** 录制时间（测试里固定）。 */
  now?: () => string;
}

/** 录制回放中间件。mode 为 off 时原样透传。 */
export function recordReplayMiddleware(opts: RecordReplayOptions): LanguageModelMiddleware {
  const now = opts.now ?? (() => new Date().toISOString());
  const store = opts.store;
  const lookup = async (hash: string) => {
    const rec = store ? await store.get(hash) : null;
    if (!rec) throw new ReplayMissError(hash);
    return rec;
  };
  return {
    specificationVersion: "v4",
    async wrapStream({ doStream, params, model }) {
      if (opts.mode === "off") return doStream();
      const hash = await promptHash(model.modelId, params as unknown as Record<string, unknown>);
      if (opts.mode === "replay") {
        const rec = await lookup(hash);
        const chunks = (rec.parts ?? []).map(revivePart);
        return { stream: simulateReadableStream({ chunks, initialDelayInMs: null, chunkDelayInMs: null }) } as Awaited<ReturnType<typeof doStream>>;
      }
      const res = await doStream();
      const parts: unknown[] = [];
      const tap = new TransformStream({
        transform(chunk, ctl) {
          parts.push(toJsonSafe(chunk));
          ctl.enqueue(chunk);
        },
        async flush() {
          await store?.put({
            schemaVersion: 1,
            promptHash: hash,
            modelId: model.modelId,
            kind: "stream",
            recordedAt: now(),
            request: { prompt: hashInput(model.modelId, params as unknown as Record<string, unknown>).prompt },
            parts,
          });
        },
      });
      return { ...res, stream: res.stream.pipeThrough(tap) };
    },
    async wrapGenerate({ doGenerate, params, model }) {
      if (opts.mode === "off") return doGenerate();
      const hash = await promptHash(model.modelId, params as unknown as Record<string, unknown>);
      if (opts.mode === "replay") {
        const rec = await lookup(hash);
        return reviveResult(rec.result) as Awaited<ReturnType<typeof doGenerate>>;
      }
      const res = await doGenerate();
      const { request: _req, ...rest } = res as unknown as Record<string, unknown>;
      await store?.put({
        schemaVersion: 1,
        promptHash: hash,
        modelId: model.modelId,
        kind: "generate",
        recordedAt: now(),
        request: { prompt: hashInput(model.modelId, params as unknown as Record<string, unknown>).prompt },
        result: toJsonSafe(rest),
      });
      return res;
    },
  };
}
