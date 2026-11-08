/**
 * JSON Canvas 1.0 读写（https://jsoncanvas.org/spec/1.0/）。
 *
 * - 标准字段直接用；我们的扩展信息放在节点 / 连线的 `x-reader` 字段。
 * - 读入时保留所有未知字段（包括其他工具写的），写回时原样带上。
 * - 键按固定顺序序列化，diff 干净。
 */
import { sortKeys } from "./stable-json.js";
import type { EdgeRole, ReaderEdge, ReaderMeta, ReaderNode } from "./types.js";
import { SCHEMA_VERSION } from "./types.js";

export const X_READER = "x-reader";

export type CanvasNodeType = "text" | "file" | "link" | "group";

/** 规范里的节点字段 + 任意未知字段。 */
export interface CanvasNode {
  id: string;
  type: CanvasNodeType;
  x: number;
  y: number;
  width: number;
  height: number;
  color?: string;
  text?: string;
  file?: string;
  subpath?: string;
  url?: string;
  label?: string;
  background?: string;
  backgroundStyle?: string;
  [X_READER]?: ReaderMeta;
  [key: string]: unknown;
}

export interface CanvasEdge {
  id: string;
  fromNode: string;
  toNode: string;
  fromSide?: string;
  fromEnd?: string;
  toSide?: string;
  toEnd?: string;
  color?: string;
  label?: string;
  [X_READER]?: { role: EdgeRole };
  [key: string]: unknown;
}

export interface CanvasDoc {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  [key: string]: unknown;
}

/** 规范字段的输出顺序；x-reader 紧随其后，其他未知字段按字母序。 */
const NODE_KEY_ORDER = [
  "id", "type", "x", "y", "width", "height", "color",
  "text", "file", "subpath", "url", "label", "background", "backgroundStyle",
  X_READER,
] as const;
const EDGE_KEY_ORDER = [
  "id", "fromNode", "fromSide", "fromEnd", "toNode", "toSide", "toEnd", "color", "label",
  X_READER,
] as const;
const DOC_KEY_ORDER = ["nodes", "edges"] as const;

export function parseCanvas(json: string): CanvasDoc {
  const raw = JSON.parse(json) as Partial<CanvasDoc>;
  return { ...raw, nodes: raw.nodes ?? [], edges: raw.edges ?? [] };
}

export function serializeCanvas(doc: CanvasDoc): string {
  // 先把每个节点 / 连线按各自字段顺序排好，再手工拼外层，避免外层排序把内层顺序打乱。
  const nodes = doc.nodes.map((n) => sortKeys(n, NODE_KEY_ORDER));
  const edges = doc.edges.map((e) => sortKeys(e, EDGE_KEY_ORDER));
  const extra = Object.keys(doc)
    .filter((k) => !DOC_KEY_ORDER.includes(k as never))
    .sort();
  const ordered: Record<string, unknown> = { nodes, edges };
  for (const k of extra) ordered[k] = sortKeys(doc[k]);
  return JSON.stringify(ordered, null, "\t") + "\n";
}

/** ReaderNode → JSON Canvas 节点。分组用 group，其余带正文的用 text（卡片短内容）。 */
export function toCanvasNode(node: ReaderNode, previous?: CanvasNode): CanvasNode {
  const base: CanvasNode = {
    ...(previous ?? {}),
    id: node.id,
    type: node.meta.type === "group" ? "group" : "text",
    x: Math.round(node.x),
    y: Math.round(node.y),
    width: Math.round(node.width),
    height: Math.round(node.height),
    [X_READER]: node.meta,
  };
  if (node.meta.type === "group") {
    if (node.label !== undefined) base.label = node.label;
    delete base.text;
  } else {
    base.text = node.text ?? "";
  }
  return base;
}

/** JSON Canvas 节点 → ReaderNode。没有 x-reader 的节点（例如用户在 Obsidian 里新建的）当作用户批注。 */
export function fromCanvasNode(n: CanvasNode): ReaderNode {
  const meta: ReaderMeta = n[X_READER] ?? {
    schemaVersion: SCHEMA_VERSION,
    type: n.type === "group" ? "group" : "note",
    status: "idle",
    createdBy: "user",
    createdAt: new Date(0).toISOString(),
  };
  const out: ReaderNode = { id: n.id, x: n.x, y: n.y, width: n.width, height: n.height, meta };
  if (typeof n.text === "string") out.text = n.text;
  if (typeof n.label === "string") out.label = n.label;
  return out;
}

export function toCanvasEdge(edge: ReaderEdge, previous?: CanvasEdge): CanvasEdge {
  const e: CanvasEdge = {
    ...(previous ?? {}),
    id: edge.id,
    fromNode: edge.from,
    toNode: edge.to,
    // 视觉规范：derived 箭头指向下游；context / reference 无箭头。
    toEnd: edge.role === "derived" ? "arrow" : "none",
    [X_READER]: { role: edge.role },
  };
  if (edge.label !== undefined) e.label = edge.label;
  return e;
}

export function fromCanvasEdge(e: CanvasEdge): ReaderEdge {
  const role = e[X_READER]?.role ?? (e.toEnd === "none" ? "context" : "derived");
  const out: ReaderEdge = { id: e.id, from: e.fromNode, to: e.toNode, role };
  if (typeof e.label === "string") out.label = e.label;
  return out;
}

/** 列出丢了 x-reader 的节点 id（例如被 Obsidian 保存后）。 */
export function nodesMissingMeta(doc: CanvasDoc): string[] {
  return doc.nodes.filter((n) => n[X_READER] === undefined).map((n) => n.id);
}
