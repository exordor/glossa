/**
 * 来源插件接口（设计文档「PDF 接入」）。Markdown 是第一个实现，PDF 在 v0.2 再实现一遍，画布、节点、AI 管线、CLI 都不改。
 * v0.1 定死：Anchor 是带 kind 的联合类型；ContextPart 支持图片；选区有文字和矩形两种形态。
 */
import type { Anchor, Granularity, Quote, SourceKind } from "./types.js";

export interface Heading {
  depth: number;
  text: string;
  /** 在来源里的字符偏移（Markdown）或页码（PDF）。 */
  position: number;
}

export interface SourceDoc {
  sourceId: string;
  kind: SourceKind;
  hash: string;
  text: string;
  headings: Heading[];
  /** 由适配器自定义的解析结果（Markdown 是 mdast）。 */
  tree: unknown;
}

export interface TextSelection {
  kind: "text";
  start: number;
  end: number;
}

export interface RectSelection {
  kind: "rect";
  page: number;
  bbox: [number, number, number, number];
}

export type Selection = TextSelection | RectSelection;

export interface Location {
  sourceId: string;
  start: number;
  end: number;
  /** 用了第几层定位：1 标题路径、2 偏移 + hash、3 引文模糊匹配。 */
  layer: 1 | 2 | 3;
}

export type ContextPart =
  | {
      kind: "text";
      /** 三层标注：选中 / 所在句 / 所在段。 */
      selected: string;
      sentence?: string;
      paragraph?: string;
      /** 同一小节里所在段之前 / 之后的块（各最多 2 个，近的贴着所在段），上下文组装第 4 项用。 */
      before?: string[];
      after?: string[];
      headingPath: string[];
    }
  | { kind: "image"; mediaType: string; data: Uint8Array | string; caption?: string };

export interface SourceAdapter {
  id: string;
  kind: SourceKind;
  /** 能处理的文件扩展名，例如 [".md"]。 */
  extensions: string[];
  parse(sourceId: string, content: string | Uint8Array): Promise<SourceDoc>;
  selectionToAnchor(doc: SourceDoc, sel: Selection, granularity?: Granularity): Anchor;
  resolve(doc: SourceDoc, anchor: Anchor): Location | null;
  extract(doc: SourceDoc, anchor: Anchor): ContextPart;
  outline(doc: SourceDoc): Heading[];
}

export type { Quote };
