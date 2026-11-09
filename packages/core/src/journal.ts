/**
 * 运行记录与使用统计（设计文档「存储与文件格式」「运行日志」、v0.1 计划第 7 步）。
 *   .canvas/runs/<YYYY-MM-DD>.jsonl  每次 AI 调用一行，追加写：分析、评测、调试用。
 *   .canvas/stats.jsonl              本地使用统计，不上传：v0.1 出口指标（追问率、跳回原文次数、首字时间）。
 * 一行一个 JSON，键按固定顺序，diff 干净。
 */
import type { AnswerDepth, Citation } from "./answer.js";
import { CANVAS_DIR } from "./canvas-store.js";
import type { AssembledContext } from "./context.js";
import { contentHash } from "./hash.js";
import type { LlmUsage, ModelCapability } from "./llm.js";
import type { ModelAlias } from "./registry.js";
import { sortKeys } from "./stable-json.js";
import { SCHEMA_VERSION } from "./types.js";
import type { Vault } from "./vault.js";

export const RUNS_DIR = `${CANVAS_DIR}/runs`;
export const STATS_FILE = `${CANVAS_DIR}/stats.jsonl`;

export interface RunContextItem {
  id: string;
  kind: string;
  tokens: number;
  nodeId?: string;
  compressed?: string;
  excluded?: boolean;
}

export interface RunRecord {
  schemaVersion: number;
  runId: string;
  at: string;
  /** 回答卡 id；就地卡（没钉到画布）为空串。 */
  nodeId: string;
  actionId: string;
  depth: AnswerDepth;
  placement: "canvas" | "inline";
  providerId: string;
  alias: ModelAlias;
  modelId: string;
  ok: boolean;
  /** 失败时的错误码（LlmErrorCode）。 */
  error?: string;
  finishReason?: string;
  /** 上下文各项的来源和 token（不含正文）。 */
  context: { tokens: number; budget: number; compressed: boolean; items: RunContextItem[] };
  /** 完整提示词：系统提示词 + 用户消息。 */
  prompt: { instructions: string; message: string };
  promptHash: string;
  /** 缓存 key = hash(动作模板 + 上下文 + 实际模型)。 */
  cacheKey: string;
  /** 模型原始输出（结构化时是 JSON 文本）。 */
  output: string;
  structured: boolean;
  usage: LlmUsage;
  firstChunkMs?: number;
  durationMs?: number;
  /** 美元；单价未知时省略。 */
  costUsd?: number;
  citations: Citation[];
  /** 没在原文里找到的引用条数。 */
  citationErrors: number;
}

export const RUN_KEY_ORDER = [
  "schemaVersion", "runId", "at", "nodeId", "actionId", "depth", "placement", "providerId", "alias", "modelId",
  "ok", "error", "finishReason", "context", "prompt", "promptHash", "cacheKey", "output", "structured",
  "usage", "firstChunkMs", "durationMs", "costUsd", "citations", "citationErrors",
] as const;

export interface RunInput {
  runId: string;
  nodeId?: string;
  actionId: string;
  /** 动作模板正文（缓存 key 用）。 */
  actionPrompt: string;
  depth: AnswerDepth;
  placement: "canvas" | "inline";
  providerId: string;
  alias: ModelAlias;
  modelId: string;
  context: AssembledContext;
  output: string;
  structured: boolean;
  ok: boolean;
  error?: string;
  finishReason?: string;
  usage?: LlmUsage;
  firstChunkMs?: number;
  durationMs?: number;
  pricing?: ModelCapability["pricing"];
  citations: Citation[];
  at?: string;
}

/** 由一次生成的结果拼出运行记录（纯函数）。 */
export function buildRunRecord(r: RunInput): RunRecord {
  const usage = r.usage ?? {};
  const rec: RunRecord = {
    schemaVersion: SCHEMA_VERSION,
    runId: r.runId,
    at: r.at ?? new Date().toISOString(),
    nodeId: r.nodeId ?? "",
    actionId: r.actionId,
    depth: r.depth,
    placement: r.placement,
    providerId: r.providerId,
    alias: r.alias,
    modelId: r.modelId,
    ok: r.ok,
    context: {
      tokens: r.context.tokens,
      budget: r.context.budget,
      compressed: r.context.compressed,
      items: r.context.items.map((it) => {
        const x: RunContextItem = { id: it.id, kind: it.kind, tokens: it.tokens };
        if (it.nodeId) x.nodeId = it.nodeId;
        if (it.compressed) x.compressed = it.compressed;
        if (it.excluded) x.excluded = true;
        return x;
      }),
    },
    prompt: { instructions: r.context.instructions, message: r.context.message },
    promptHash: contentHash(`${r.context.instructions}\n\n${r.context.message}`),
    cacheKey: contentHash(`${contentHash(r.actionPrompt)}|${contentHash(r.context.message)}|${r.modelId}`),
    output: r.output,
    structured: r.structured,
    usage,
    citations: r.citations,
    citationErrors: r.citations.filter((c) => !c.verified).length,
  };
  if (r.error) rec.error = r.error;
  if (r.finishReason) rec.finishReason = r.finishReason;
  if (r.firstChunkMs !== undefined) rec.firstChunkMs = r.firstChunkMs;
  if (r.durationMs !== undefined) rec.durationMs = r.durationMs;
  if (r.pricing && (usage.inputTokens !== undefined || usage.outputTokens !== undefined)) {
    const cost = ((usage.inputTokens ?? 0) * r.pricing.inputPerMTok + (usage.outputTokens ?? 0) * r.pricing.outputPerMTok) / 1e6;
    rec.costUsd = Math.round(cost * 1e6) / 1e6;
  }
  return rec;
}

/** 使用统计事件（stats.jsonl）。只记行为，不记原文。 */
export type StatEvent =
  /** 选中文字后点了动作。followup：在已有回答的段落上再问（追问率的分子）。 */
  | { event: "action"; actionId: string; placement: "canvas" | "inline"; followup: boolean }
  /** 从选中动作到回答首字的毫秒数。 */
  | { event: "first-token"; actionId: string; ms: number }
  /** 跳回原文。 */
  | { event: "locate"; nodeId: string; sourceId: string }
  /** 就地卡钉到画布。 */
  | { event: "pin"; actionId: string }
  /** 切换回答深度重新生成。 */
  | { event: "depth"; actionId: string; depth: AnswerDepth }
  /** 打开「本次上下文」面板 / 去掉某几项重跑。 */
  | { event: "context"; action: "open" | "rerun"; excluded: number };

export type StatRecord = StatEvent & { schemaVersion: number; at: string };

const runFile = (at: string) => `${RUNS_DIR}/${at.slice(0, 10)}.jsonl`;

/** 追加写 jsonl。同一文件的写入排队，避免并发时互相覆盖。 */
export class Journal {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly vault: Vault) {}

  private append(path: string, line: string): Promise<void> {
    const next = this.queue.then(async () => {
      const prev = (await this.vault.readText(path)) ?? "";
      await this.vault.writeText(path, prev + line + "\n");
    });
    this.queue = next.catch(() => {});
    return next;
  }

  recordRun(rec: RunRecord): Promise<void> {
    return this.append(runFile(rec.at), JSON.stringify(sortKeys(rec, RUN_KEY_ORDER)));
  }

  recordStat(e: StatEvent, at = new Date().toISOString()): Promise<void> {
    const rec = { schemaVersion: SCHEMA_VERSION, at, ...e };
    return this.append(STATS_FILE, JSON.stringify(sortKeys(rec, ["schemaVersion", "at", "event"])));
  }

  /** 读某一天（YYYY-MM-DD）的运行记录；坏行跳过。 */
  async listRuns(day: string): Promise<RunRecord[]> {
    return parseLines<RunRecord>(await this.vault.readText(`${RUNS_DIR}/${day}.jsonl`));
  }

  async listStats(): Promise<StatRecord[]> {
    return parseLines<StatRecord>(await this.vault.readText(STATS_FILE));
  }
}

function parseLines<T>(text: string | null): T[] {
  if (!text) return [];
  return text.split("\n").flatMap((l) => {
    if (!l.trim()) return [];
    try {
      return [JSON.parse(l) as T];
    } catch {
      return [];
    }
  });
}

/** v0.1 出口指标（设计文档「成功指标」）：追问率、跳回原文次数、首字时间中位数。 */
export function summarizeStats(stats: StatRecord[]): {
  actions: number;
  followups: number;
  followupRate: number | null;
  locates: number;
  firstTokenMedianMs: number | null;
} {
  const actions = stats.filter((s) => s.event === "action");
  const followups = actions.filter((s) => s.event === "action" && s.followup).length;
  const ms = stats.flatMap((s) => (s.event === "first-token" ? [s.ms] : [])).sort((a, b) => a - b);
  const mid = ms.length ? (ms.length % 2 ? ms[(ms.length - 1) / 2]! : (ms[ms.length / 2 - 1]! + ms[ms.length / 2]!) / 2) : null;
  return {
    actions: actions.length,
    followups,
    followupRate: actions.length ? followups / actions.length : null,
    locates: stats.filter((s) => s.event === "locate").length,
    firstTokenMedianMs: mid,
  };
}
