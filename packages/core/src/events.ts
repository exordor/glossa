/**
 * 事件总线。事件名稳定，和 schemas/events.json 保持一致（有测试校验）。
 * 负载必须可序列化，不传 DOM 对象：以后插件迁到 Worker / iframe 时不用改。
 */
import type { ModelAlias } from "./registry.js";
import type { Anchor, ReaderNode } from "./types.js";

export interface ReaderEvents {
  "selection.changed": { sourceId: string; anchor: Anchor | null };
  "node.created": { node: ReaderNode };
  "run.completed": { runId: string; nodeId: string; ok: boolean };
  "source.changed": { sourceId: string; path: string; hash: string };
  /** 一次 LLM 调用开始（已通过能力检查）。nodeId 为空串表示不属于任何节点。 */
  "run.started": { runId: string; nodeId: string; providerId: string; alias: ModelAlias; modelId: string };
  /** 全局设置已保存。keys 为变化的路径（最多两层），不含密钥。 */
  "settings.changed": { keys: string[] };
}

export type ReaderEventName = keyof ReaderEvents;

export const EVENT_NAMES: readonly ReaderEventName[] = [
  "selection.changed",
  "node.created",
  "run.completed",
  "source.changed",
  "run.started",
  "settings.changed",
];

export class EventBus {
  private readonly handlers = new Map<ReaderEventName, Set<(p: never) => void>>();

  on<E extends ReaderEventName>(name: E, fn: (payload: ReaderEvents[E]) => void): () => void {
    let set = this.handlers.get(name);
    if (!set) this.handlers.set(name, (set = new Set()));
    set.add(fn as (p: never) => void);
    return () => set.delete(fn as (p: never) => void);
  }

  emit<E extends ReaderEventName>(name: E, payload: ReaderEvents[E]): void {
    // 结构化克隆一次：保证负载可序列化，也防止订阅者改到发送方的对象。
    const copy = structuredClone(payload);
    for (const fn of this.handlers.get(name) ?? []) (fn as (p: ReaderEvents[E]) => void)(copy);
  }
}
