/**
 * 扩展点注册表（设计文档「主题与第三方插件接口」）。
 * 内置动作、来源适配器、面板从第一天起都用 register() 注册，不走后门；第三方插件在 v0.3 用同一个入口。
 */
import type { SourceAdapter } from "./source.js";

export interface ActionTemplate {
  id: string;
  name: string;
  /** 模型别名：fast / smart / vision / image。 */
  model: ModelAlias;
  input: Array<"word" | "sentence" | "passage" | "chapter" | "image">;
  depth: "brief" | "points" | "steps";
  /** 是否调用 AI（「批注」不调）。 */
  usesLLM: boolean;
  /** 模板正文。 */
  prompt: string;
}

export type ModelAlias = "fast" | "smart" | "vision" | "image";

export interface ThemeContribution {
  id: string;
  name: string;
  modes: Array<"light" | "dark">;
  tokens: Partial<Record<"light" | "dark", Record<string, string>>>;
  css?: string;
}

export interface PanelContribution {
  id: string;
  title: string;
  /** 渲染器由界面层解释；核心只存可序列化描述。 */
  component: string;
}

export interface CommandContribution {
  id: string;
  title: string;
  hotkey?: string;
  run: (args?: unknown) => Promise<void>;
}

export interface ContextProviderContribution {
  id: string;
  /** 压缩优先级：1 最先压。 */
  priority: number;
  maxTokens?: number;
  provide: (input: unknown) => Promise<unknown>;
}

/** 扩展点 → 实现类型。新扩展点在这里加一行。 */
export interface ExtensionPoints {
  theme: ThemeContribution;
  source: SourceAdapter;
  action: ActionTemplate;
  workflow: { id: string; name: string; graph: unknown };
  nodeType: { id: string; schema: unknown; component: string };
  command: CommandContribution;
  panel: PanelContribution;
  contextProvider: ContextProviderContribution;
  llmProvider: { id: string; create: (config: unknown) => unknown };
  tool: { id: string; server: string };
}

export type ExtensionPoint = keyof ExtensionPoints;

export const EXTENSION_POINTS: readonly ExtensionPoint[] = [
  "theme", "source", "action", "workflow", "nodeType",
  "command", "panel", "contextProvider", "llmProvider", "tool",
];

export interface Registration {
  /** "builtin" 或 "plugin:<id>"。 */
  owner: string;
  dispose: () => void;
}

type Entry<P extends ExtensionPoint> = { impl: ExtensionPoints[P] & { id: string }; owner: string };

export class Registry {
  private readonly entries = new Map<ExtensionPoint, Map<string, Entry<ExtensionPoint>>>();
  private readonly listeners = new Set<(point: ExtensionPoint, id: string) => void>();

  register<P extends ExtensionPoint>(
    point: P,
    impl: ExtensionPoints[P] & { id: string },
    owner = "builtin",
  ): Registration {
    if (!EXTENSION_POINTS.includes(point)) throw new Error(`未知扩展点：${point}`);
    let bucket = this.entries.get(point);
    if (!bucket) this.entries.set(point, (bucket = new Map()));
    if (bucket.has(impl.id)) throw new Error(`${point} 已注册同名实现：${impl.id}`);
    bucket.set(impl.id, { impl, owner } as Entry<ExtensionPoint>);
    this.emit(point, impl.id);
    return {
      owner,
      dispose: () => {
        bucket.delete(impl.id);
        this.emit(point, impl.id);
      },
    };
  }

  get<P extends ExtensionPoint>(point: P, id: string): ExtensionPoints[P] | undefined {
    return this.entries.get(point)?.get(id)?.impl as ExtensionPoints[P] | undefined;
  }

  list<P extends ExtensionPoint>(point: P): Array<ExtensionPoints[P]> {
    return [...(this.entries.get(point)?.values() ?? [])].map((e) => e.impl as ExtensionPoints[P]);
  }

  ownerOf(point: ExtensionPoint, id: string): string | undefined {
    return this.entries.get(point)?.get(id)?.owner;
  }

  onChange(fn: (point: ExtensionPoint, id: string) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(point: ExtensionPoint, id: string) {
    for (const fn of this.listeners) fn(point, id);
  }
}
