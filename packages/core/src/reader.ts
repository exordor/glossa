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
import { NODES_DIR } from "./canvas-store.js";
import { parseNodeFile } from "./frontmatter.js";

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
  /**
   * 删掉的节点和连线（墓碑），撤销时原样恢复。只在内存里：关掉书后撤销栈也没了。
   * 节点墓碑带正文，因为保存时 nodes/<id>.md 会被删。
   */
  private tombNodes = new Map<string, { node: ReaderNode; body: string | undefined }>();
  private tombEdges = new Map<string, { edge: ReaderEdge; withNode: boolean }>();
  /** 已删、待保存时移除 nodes/<id>.md 的节点 id。 */
  private removed = new Set<string>();

  constructor(
    readonly vault: Vault,
    opts: ReaderOptions = {},
  ) {
    this.llm = createAppLlm({ registry: this.registry, events: this.events, settings: opts.settings }).llm;
    this.journal = new Journal(vault);
  }

  async open(): Promise<{ nodes: number; edges: number; repaired: string[] }> {
    this.canvas = await loadCanvas(this.vault);
    this.tombNodes.clear();
    this.tombEdges.clear();
    this.removed.clear();
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

  /**
   * 删节点，连带删掉连到它们的连线。删掉的内容留作墓碑，restore() 能原样找回（画布撤销用）。
   * 返回实际删掉的节点和连线 id。
   */
  async deleteNodes(ids: string[]): Promise<{ nodes: string[]; edges: string[] }> {
    const c = this.require();
    const drop = new Set(ids);
    const gone = c.nodes.filter((n) => drop.has(n.id));
    if (!gone.length) return { nodes: [], edges: [] };
    for (const n of gone) {
      let body: string | undefined = this.bodies[n.id];
      if (body === undefined) {
        const md = await this.vault.readText(`${NODES_DIR}/${n.id}.md`);
        body = md === null ? undefined : parseNodeFile(md).body;
      }
      delete this.bodies[n.id];
      this.tombNodes.set(n.id, { node: structuredClone(n), body });
      this.removed.add(n.id);
    }
    // 读正文时有 await：重新按 id 过滤，别用过期的数组下标。
    c.nodes = c.nodes.filter((n) => !drop.has(n.id));
    const edges = c.edges.filter((e) => drop.has(e.from) || drop.has(e.to));
    for (const e of edges) this.tombEdges.set(e.id, { edge: structuredClone(e), withNode: true });
    c.edges = c.edges.filter((e) => !(drop.has(e.from) || drop.has(e.to)));
    const result = { nodes: gone.map((n) => n.id), edges: edges.map((e) => e.id) };
    this.events.emit("node.deleted", result);
    return result;
  }

  /** 只删连线。 */
  async deleteEdges(ids: string[]): Promise<string[]> {
    const c = this.require();
    const drop = new Set(ids);
    const gone = c.edges.filter((e) => drop.has(e.id));
    for (const e of gone) this.tombEdges.set(e.id, { edge: structuredClone(e), withNode: false });
    c.edges = c.edges.filter((e) => !drop.has(e.id));
    return gone.map((e) => e.id);
  }

  /**
   * 从墓碑恢复删掉的节点和连线（撤销删除、重做新建）。已经存在的跳过；
   * 随节点一起删掉的连线，两端都回来时自动恢复；单独删的连线要在 edges 里点名。返回实际恢复的节点和连线。
   */
  async restore(ids: { nodes?: string[]; edges?: string[] }): Promise<{ nodes: ReaderNode[]; edges: ReaderEdge[] }> {
    const c = this.require();
    const nodes: ReaderNode[] = [];
    for (const id of ids.nodes ?? []) {
      const t = this.tombNodes.get(id);
      if (!t || c.nodes.some((n) => n.id === id)) continue;
      c.nodes.push(structuredClone(t.node));
      if (t.body !== undefined) this.bodies[id] = t.body;
      this.removed.delete(id);
      this.tombNodes.delete(id);
      nodes.push(structuredClone(t.node));
    }
    const has = new Set(c.nodes.map((n) => n.id));
    const edges: ReaderEdge[] = [];
    const named = new Set(ids.edges ?? []);
    for (const [id, t] of [...this.tombEdges]) {
      const e = t.edge;
      if (!(named.has(id) || (t.withNode && nodes.length)) || !has.has(e.from) || !has.has(e.to)) continue;
      if (!c.edges.some((x) => x.id === id)) {
        c.edges.push(structuredClone(e));
        edges.push(structuredClone(e));
      }
      this.tombEdges.delete(id);
    }
    if (nodes.length || edges.length) this.events.emit("node.restored", { nodes: nodes.map((n) => n.id), edges: edges.map((e) => e.id) });
    return { nodes, edges };
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
    const removed = [...this.removed];
    try {
      await saveCanvas(this.vault, this.require(), { bodies });
      for (const id of removed) {
        // 保存期间又被撤销恢复的，文件要留着。
        if (!this.removed.has(id)) continue;
        await this.vault.remove(`${NODES_DIR}/${id}.md`);
        this.removed.delete(id);
      }
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
