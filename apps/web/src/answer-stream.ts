/**
 * 回答的流式累积：结构化对象（JSON schema 输出）优先，模型没给 JSON 时退回按文字解析。
 * 纯逻辑，回答卡和就地卡共用，便于测试。
 */
import {
  type AnswerDepth,
  type Citation,
  type LlmChunk,
  type LlmUsage,
  type ModelAlias,
  answerFromObject,
  answerToMarkdown,
  parseAnswer,
} from "@reader/core";

/** 还没解析出对象时的原始文字像不像 JSON（是的话先不显示，免得闪一下花括号）。 */
const looksLikeJson = (t: string) => /^\s*(\{|```)/.test(t);

/** 运行记录要用的元信息（来自 start / finish / error 分块）。 */
export interface RunMeta {
  providerId?: string;
  alias?: ModelAlias;
  modelId?: string;
  finishReason?: string;
  usage?: LlmUsage;
  firstChunkMs?: number;
  durationMs?: number;
  error?: string;
  /** 本地计时：从开始到第一块文字 / 对象的毫秒数（含上下文组装）。 */
  firstVisibleMs?: number;
}

export class AnswerAccumulator {
  private raw = "";
  private obj: unknown = undefined;
  private final = false;
  readonly meta: RunMeta = {};
  private readonly t0 = Date.now();

  constructor(private readonly depth: AnswerDepth) {}

  /** 模型原始输出（结构化时是 JSON 文本）。 */
  get output(): string {
    return this.raw;
  }

  /** 拿到了完整合法的结构化对象。 */
  get structured(): boolean {
    return this.final;
  }

  /** 喂一个分块；返回显示内容是否可能变了。 */
  push(c: LlmChunk): boolean {
    if (c.type === "start") {
      Object.assign(this.meta, { providerId: c.providerId, alias: c.alias, modelId: c.modelId });
      return false;
    }
    if (c.type === "finish") {
      Object.assign(this.meta, { finishReason: c.finishReason, usage: c.usage, durationMs: c.durationMs });
      if (c.firstChunkMs !== undefined) this.meta.firstChunkMs = c.firstChunkMs;
      return false;
    }
    if (c.type === "error") {
      this.meta.error = c.error.code;
      return false;
    }
    if ((c.type === "text" || c.type === "object") && this.meta.firstVisibleMs === undefined) this.meta.firstVisibleMs = Date.now() - this.t0;
    if (c.type === "text") {
      this.raw += c.delta;
      return this.obj === undefined;
    }
    if (c.type === "object") {
      this.obj = c.value;
      if (c.final) this.final = true;
      return true;
    }
    return false;
  }

  /** 当前显示用的 Markdown。 */
  display(): string {
    if (this.obj !== undefined) return answerToMarkdown(answerFromObject(this.obj, this.depth));
    return looksLikeJson(this.raw) ? "" : this.raw;
  }

  /** 结束：得到最终显示文字和引用校验结果。 */
  finish(sources: string[]): { text: string; citations: Citation[] } {
    const a =
      this.obj !== undefined ? answerFromObject(this.obj, this.depth, sources) : parseAnswer(this.raw, this.depth, sources);
    // 退回按文字解析时保留原文（模型可能写了解析不出的段落）；结构化时用规整后的 Markdown。
    return { text: this.obj !== undefined ? answerToMarkdown(a) : this.raw.trim(), citations: a.citations };
  }
}
