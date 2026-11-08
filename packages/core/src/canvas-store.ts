/**
 * 画布存储：.canvas/main.canvas + .canvas/nodes/<id>.md 双写。
 *
 * Round-trip 对策（设计文档「存储与文件格式」）：
 * Obsidian 等第三方写回 main.canvas 时可能丢掉 x-reader。所以节点类型、锚点、状态、版本同时写进
 * nodes/<id>.md 的 front matter；加载时若发现 main.canvas 丢了字段，从那里补回。
 * 没有正文的节点（摘录、操作）也写一份最小的 nodes/<id>.md。
 */
import {
  type CanvasDoc,
  type CanvasEdge,
  type CanvasNode,
  X_READER,
  fromCanvasEdge,
  fromCanvasNode,
  parseCanvas,
  serializeCanvas,
  toCanvasEdge,
  toCanvasNode,
} from "./canvas.js";
import { parseNodeFile, serializeNodeFile } from "./frontmatter.js";
import type { ReaderEdge, ReaderNode } from "./types.js";
import type { Vault } from "./vault.js";

export const CANVAS_DIR = ".canvas";
export const MAIN_CANVAS = `${CANVAS_DIR}/main.canvas`;
export const NODES_DIR = `${CANVAS_DIR}/nodes`;

export interface LoadedCanvas {
  nodes: ReaderNode[];
  edges: ReaderEdge[];
  /** 原始文档，保存时用来保留未知字段和第三方新建的节点字段。 */
  raw: CanvasDoc;
  /** 从 nodes/<id>.md 补回了 x-reader 的节点 id。 */
  repaired: string[];
}

export async function loadCanvas(vault: Vault): Promise<LoadedCanvas> {
  const text = await vault.readText(MAIN_CANVAS);
  const raw = text ? parseCanvas(text) : { nodes: [], edges: [] };
  const repaired: string[] = [];

  for (const n of raw.nodes) {
    if (n[X_READER] !== undefined) continue;
    const md = await vault.readText(`${NODES_DIR}/${n.id}.md`);
    if (md === null) continue; // 用户在 Obsidian 里新建的卡片：没有 .md，按普通批注处理
    n[X_READER] = parseNodeFile(md).meta;
    repaired.push(n.id);
  }

  return {
    nodes: raw.nodes.map(fromCanvasNode),
    edges: raw.edges.map(fromCanvasEdge),
    raw,
    repaired,
  };
}

export interface SaveOptions {
  /** 节点正文（回答全文、批注全文），键为节点 id；不给时保留已有正文。 */
  bodies?: Record<string, string>;
}

export async function saveCanvas(
  vault: Vault,
  canvas: Pick<LoadedCanvas, "nodes" | "edges"> & { raw?: CanvasDoc },
  opts: SaveOptions = {},
): Promise<void> {
  const prevNodes = new Map<string, CanvasNode>((canvas.raw?.nodes ?? []).map((n) => [n.id, n]));
  const prevEdges = new Map<string, CanvasEdge>((canvas.raw?.edges ?? []).map((e) => [e.id, e]));

  const doc: CanvasDoc = {
    ...(canvas.raw ?? {}),
    nodes: canvas.nodes.map((n) => toCanvasNode(n, prevNodes.get(n.id))),
    edges: canvas.edges.map((e) => toCanvasEdge(e, prevEdges.get(e.id))),
  };
  await vault.writeText(MAIN_CANVAS, serializeCanvas(doc));

  for (const n of canvas.nodes) {
    const path = `${NODES_DIR}/${n.id}.md`;
    let body = opts.bodies?.[n.id];
    if (body === undefined) {
      const existing = await vault.readText(path);
      body = existing ? parseNodeFile(existing).body : "";
    }
    await vault.writeText(path, serializeNodeFile({ id: n.id, meta: n.meta, body }));
  }
}
