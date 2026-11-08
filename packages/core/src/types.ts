/**
 * 数据模型（设计文档 v2「核心概念与数据模型」）。
 * 所有 id 用 ULID，所有落盘文件带 schemaVersion。
 */

export const SCHEMA_VERSION = 1;

/** 引文：W3C Web Annotation TextQuoteSelector，前后各 32 字。 */
export interface Quote {
  exact: string;
  prefix: string;
  suffix: string;
}

export type Granularity = "block" | "sentence" | "phrase" | "word";

/** Markdown 锚点：三层定位，按顺序尝试。 */
export interface MarkdownAnchor {
  kind: "markdown";
  sourceId: string;
  /** 第一层：标题路径 + 块序号，如 ["第 3 章", "3.2 注意力"] + 3（第 4 段，0 起）。 */
  headingPath: string[];
  blockIndex: number;
  /** 第二层：字符偏移 + 文件 hash，hash 一致时精确命中。 */
  start: number;
  end: number;
  fileHash: string;
  /** 第三层：引文模糊匹配。 */
  quote: Quote;
  granularity: Granularity;
  /** 图片块：图片序号 + src，引文存图注。 */
  image?: { index: number; src: string };
}

/** PDF 锚点（v0.2 实现）：页码 + bbox + 引文。 */
export interface PdfAnchor {
  kind: "pdf";
  sourceId: string;
  page: number;
  /** PDF 用户空间坐标 [x0, y0, x1, y1]。 */
  bbox: [number, number, number, number];
  quote: Quote;
  granularity: Granularity;
}

export type Anchor = MarkdownAnchor | PdfAnchor;

export type SourceKind = "markdown" | "pdf";

export interface Source {
  id: string;
  kind: SourceKind;
  /** 相对书文件夹的路径。 */
  path: string;
  hash: string;
  order: number;
  title?: string;
}

export interface Book {
  schemaVersion: number;
  id: string;
  title: string;
  authors?: string[];
  sources: Source[];
}

export type NodeType = "chapter" | "excerpt" | "operation" | "answer" | "note" | "group";
export type NodeGroup = "source" | "ai" | "user";
export type NodeStatus = "idle" | "running" | "done" | "failed" | "stale";
/** user / ai / agent（外部 agent 经 CLI、MCP）/ plugin:<id>。 */
export type CreatedBy = "user" | "ai" | "agent" | `plugin:${string}`;

export const NODE_GROUP: Record<NodeType, NodeGroup> = {
  chapter: "source",
  excerpt: "source",
  operation: "ai",
  answer: "ai",
  note: "user",
  group: "user",
};

/** 写进 main.canvas 节点的 x-reader 字段，同时双写进 nodes/<id>.md 的 front matter。 */
export interface ReaderMeta {
  schemaVersion: number;
  type: NodeType;
  status: NodeStatus;
  createdBy: CreatedBy;
  createdAt: string;
  anchor?: Anchor;
  /** 问答卡合成：一次提问的摘录 + 操作 + 回答共享同一个 parentQA。 */
  parentQA?: string;
  /** 在某张摘录卡里再选字创建时记录（显式意图）。 */
  withinNodeId?: string;
  /** 回答的多版本。 */
  version?: number;
  /** 用户拖过之后不再自动布局。 */
  pinned?: boolean;
  /** 回答卡：生成时用的回答深度。 */
  depth?: "brief" | "points" | "steps";
  /** 回答卡：回答里引用的原话及是否在原文里找到（见 answer.ts）。 */
  citations?: { quote: string; verified: boolean }[];
}

export type EdgeRole = "context" | "derived" | "reference";

export interface ReaderNode {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  meta: ReaderMeta;
  /** 卡片上显示的短内容（摘要、结论、批注）。正文在 nodes/<id>.md。 */
  text?: string;
  label?: string;
}

export interface ReaderEdge {
  id: string;
  from: string;
  to: string;
  role: EdgeRole;
  label?: string;
}
