/**
 * @reader/core 的门面：界面、CLI、MCP、插件拿到的是同一个 reader 对象。
 * 所有方法异步、参数与返回值可序列化。
 */
import { EventBus } from "./events.js";
import { newId } from "./ids.js";
import { type LoadedCanvas, loadCanvas, saveCanvas } from "./canvas-store.js";
import { Registry } from "./registry.js";
import { type LlmService, createAppLlm } from "./llm-service.js";
import type { SettingsStore } from "./settings.js";
import { type ImportResult, type ViewState, importBook, readBook, readView, writeView } from "./book.js";
import type { Book } from "./types.js";
import type { ReaderEdge, ReaderMeta, ReaderNode } from "./types.js";
import { SCHEMA_VERSION } from "./types.js";
import type { Vault } from "./vault.js";
import { Journal } from "./journal.js";

export const API_VERSION = "0.2.0";

export interface CreateNodeInput {
  type: ReaderMeta["type"];
  x: number;
  y: number;
  width: number;
  height: number;
  text?: string;
  label?: string;
  body?: string;
  createdBy?: ReaderMeta["createdBy"];
  anchor?: ReaderMeta["anchor"];
  /** 默认 idle。AI 卡创建时就是 running，流式写完再改。 */
  status?: ReaderMeta["status"];
  version?: number;
  parentQA?: string;
  withinNodeId?: string;
  depth?: ReaderMeta["depth"];
  citations?: ReaderMeta["citations"];
}

export interface ReaderOptions {
  /** 全局设置的存取（浏览器走 dev bridge，Node 用 NodeSettingsStore）；不传时用内存实现，不落盘。 */
  settings?: SettingsStore;
}

export class Reader {
  readonly apiVersion = API_VERSION;
  readonly registry = new Registry();
  readonly events = new EventBus();
  /** LLM 网关：run / cancel / test / listModels / 设置读写。provider 要另外注册到 registry。 */
  readonly llm: LlmService;
  /** 运行记录（.canvas/runs/*.jsonl）与使用统计（.canvas/stats.jsonl），追加写。 */
  readonly journal: Journal;
  private canvas: LoadedCanvas | null = null;
  private bodies: Record<string, string> = {};

  constructor(
    readonly vault: Vault,
    opts: ReaderOptions = {},
  ) {
    this.llm = createAppLlm({ registry: this.registry, events: this.events, settings: opts.settings }).llm;
    this.journal = new Journal(vault);
  }

  async open(): Promise<{ nodes: number; edges: number; repaired: string[] }> {
    this.canvas = await loadCanvas(this.vault);
    return { nodes: this.canvas.nodes.length, edges: this.canvas.edges.length, repaired: this.canvas.repaired };
  }

  async listNodes(): Promise<ReaderNode[]> {
    return structuredClone(this.require().nodes);
  }

  async listEdges(): Promise<ReaderEdge[]> {
    return structuredClone(this.require().edges);
  }

  async createNode(input: CreateNodeInput): Promise<ReaderNode> {
    const c = this.require();
    const meta: ReaderMeta = {
      schemaVersion: SCHEMA_VERSION,
      type: input.type,
      status: input.status ?? "idle",
      createdBy: input.createdBy ?? "user",
      createdAt: new Date().toISOString(),
    };
    if (input.anchor) meta.anchor = input.anchor;
    if (input.version !== undefined) meta.version = input.version;
    if (input.parentQA) meta.parentQA = input.parentQA;
    if (input.withinNodeId) meta.withinNodeId = input.withinNodeId;
    if (input.depth) meta.depth = input.depth;
    if (input.citations) meta.citations = structuredClone(input.citations);
    const node: ReaderNode = { id: newId(), x: input.x, y: input.y, width: input.width, height: input.height, meta };
    if (input.text !== undefined) node.text = input.text;
    if (input.label !== undefined) node.label = input.label;
    c.nodes.push(node);
    if (input.body !== undefined) this.bodies[node.id] = input.body;
    this.events.emit("node.created", { node });
    return structuredClone(node);
  }

  /**
   * 改节点的显示内容或状态（AI 卡流式写入、完成、失败）。只改内存，save() 时落盘；
   * body 是 nodes/<id>.md 的正文（回答全文）。节点不存在时返回 null。
   */
  async updateNode(
    id: string,
    patch: {
      text?: string;
      label?: string;
      status?: ReaderMeta["status"];
      body?: string;
      depth?: ReaderMeta["depth"];
      citations?: ReaderMeta["citations"];
    },
  ): Promise<ReaderNode | null> {
    const node = this.require().nodes.find((n) => n.id === id);
    if (!node) return null;
    if (patch.text !== undefined) node.text = patch.text;
    if (patch.label !== undefined) node.label = patch.label;
    if (patch.status !== undefined) node.meta.status = patch.status;
    if (patch.body !== undefined) this.bodies[id] = patch.body;
    if (patch.depth !== undefined) node.meta.depth = patch.depth;
    if (patch.citations !== undefined) node.meta.citations = structuredClone(patch.citations);
    return structuredClone(node);
  }

  async connect(from: string, to: string, role: ReaderEdge["role"], label?: string): Promise<ReaderEdge> {
    const c = this.require();
    const edge: ReaderEdge = { id: newId(), from, to, role };
    if (label !== undefined) edge.label = label;
    c.edges.push(edge);
    return structuredClone(edge);
  }

  /** 导入（或重新扫描）当前文件夹为一本书，然后重新载入画布。 */
  async importBook(folderName: string): Promise<ImportResult> {
    const result = await importBook(this.vault, this.registry, folderName);
    await this.open();
    return result;
  }

  async getBook(): Promise<Book | null> {
    return readBook(this.vault);
  }

  /** 读来源文件全文。 */
  async readSource(sourceId: string): Promise<{ path: string; text: string } | null> {
    const book = await readBook(this.vault);
    const src = book?.sources.find((s) => s.id === sourceId);
    if (!src) return null;
    const text = await this.vault.readText(src.path);
    return text === null ? null : { path: src.path, text };
  }

  /** 用户拖动节点：更新位置，并标记 pinned，之后自动布局不再移动它。 */
  async moveNode(id: string, x: number, y: number): Promise<void> {
    const node = this.require().nodes.find((n) => n.id === id);
    if (!node) return;
    node.x = x;
    node.y = y;
    node.meta.pinned = true;
  }

  async getView(): Promise<ViewState | null> {
    return readView(this.vault);
  }

  /** 合并写入：只传要改的字段，没传的保留原值。 */
  async saveView(view: Partial<Omit<ViewState, "schemaVersion">>): Promise<void> {
    const prev = await readView(this.vault);
    const { schemaVersion: _, ...rest } = prev ?? { schemaVersion: 0 };
    await writeView(this.vault, { ...rest, ...view });
  }

  async save(): Promise<void> {
    // 先换出待写正文再 await：保存进行中 updateNode 设的正文（如流式回答结束时）留给下一次 save，不会被清掉。
    const bodies = this.bodies;
    this.bodies = {};
    try {
      await saveCanvas(this.vault, this.require(), { bodies });
    } catch (e) {
      this.bodies = { ...bodies, ...this.bodies };
      throw e;
    }
  }

  private require(): LoadedCanvas {
    if (!this.canvas) throw new Error("先调用 reader.open()");
    return this.canvas;
  }
}

export function createReader(vault: Vault, opts: ReaderOptions = {}): Reader {
  return new Reader(vault, opts);
}
