/**
 * @reader/core 的门面：界面、CLI、MCP、插件拿到的是同一个 reader 对象。
 * 所有方法异步、参数与返回值可序列化。
 */
import { EventBus } from "./events.js";
import { newId } from "./ids.js";
import { type LoadedCanvas, loadCanvas, saveCanvas } from "./canvas-store.js";
import { Registry } from "./registry.js";
import type { ReaderEdge, ReaderMeta, ReaderNode } from "./types.js";
import { SCHEMA_VERSION } from "./types.js";
import type { Vault } from "./vault.js";

export const API_VERSION = "0.1.0";

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
  parentQA?: string;
  withinNodeId?: string;
}

export class Reader {
  readonly apiVersion = API_VERSION;
  readonly registry = new Registry();
  readonly events = new EventBus();
  private canvas: LoadedCanvas | null = null;
  private bodies: Record<string, string> = {};

  constructor(readonly vault: Vault) {}

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
      status: "idle",
      createdBy: input.createdBy ?? "user",
      createdAt: new Date().toISOString(),
    };
    if (input.anchor) meta.anchor = input.anchor;
    if (input.parentQA) meta.parentQA = input.parentQA;
    if (input.withinNodeId) meta.withinNodeId = input.withinNodeId;
    const node: ReaderNode = { id: newId(), x: input.x, y: input.y, width: input.width, height: input.height, meta };
    if (input.text !== undefined) node.text = input.text;
    if (input.label !== undefined) node.label = input.label;
    c.nodes.push(node);
    if (input.body !== undefined) this.bodies[node.id] = input.body;
    this.events.emit("node.created", { node });
    return structuredClone(node);
  }

  async connect(from: string, to: string, role: ReaderEdge["role"], label?: string): Promise<ReaderEdge> {
    const c = this.require();
    const edge: ReaderEdge = { id: newId(), from, to, role };
    if (label !== undefined) edge.label = label;
    c.edges.push(edge);
    return structuredClone(edge);
  }

  async save(): Promise<void> {
    await saveCanvas(this.vault, this.require(), { bodies: this.bodies });
    this.bodies = {};
  }

  private require(): LoadedCanvas {
    if (!this.canvas) throw new Error("先调用 reader.open()");
    return this.canvas;
  }
}

export function createReader(vault: Vault): Reader {
  return new Reader(vault);
}
