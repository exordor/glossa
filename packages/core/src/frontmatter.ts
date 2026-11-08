/**
 * nodes/<id>.md：front matter = 节点全部元数据（可由此重建 main.canvas 的 x-reader），正文 = 回答或批注全文。
 */
import { parse, stringify } from "yaml";
import { sortKeys } from "./stable-json.js";
import type { ReaderMeta } from "./types.js";

export interface NodeFile {
  id: string;
  meta: ReaderMeta;
  body: string;
}

const META_KEY_ORDER = [
  "id", "schemaVersion", "type", "status", "createdBy", "createdAt",
  "parentQA", "withinNodeId", "version", "pinned", "depth", "anchor", "citations",
] as const;

export function serializeNodeFile(file: NodeFile): string {
  const fm = sortKeys({ id: file.id, ...file.meta }, META_KEY_ORDER);
  const yaml = stringify(fm, { lineWidth: 0 });
  const body = file.body.endsWith("\n") || file.body === "" ? file.body : file.body + "\n";
  return `---\n${yaml}---\n${body}`;
}

export function parseNodeFile(text: string): NodeFile {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) throw new Error("nodes/<id>.md 缺少 front matter");
  const data = parse(m[1] ?? "") as Record<string, unknown> & { id: string };
  const { id, ...meta } = data;
  return { id, meta: meta as unknown as ReaderMeta, body: m[2] ?? "" };
}
