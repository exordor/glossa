/**
 * 画布同步：@reader/core 的节点是数据，tldraw 的 shape 是它的显示。
 * 第 3 步之前先用 tldraw 自带的 geo 形状占位，颜色按分组（原文灰 / AI 蓝 / 用户琥珀）。
 */
import { type Editor, type TLShapeId, createShapeId, toRichText } from "tldraw";
import { NODE_GROUP, type ReaderNode } from "@reader/core";

const GROUP_COLOR = { source: "grey", ai: "blue", user: "orange" } as const;

export const shapeIdOf = (nodeId: string): TLShapeId => createShapeId(nodeId);
export const nodeIdOf = (shapeId: string): string => shapeId.replace(/^shape:/, "");

export function syncShapes(editor: Editor, nodes: ReaderNode[]) {
  const toCreate = nodes
    .filter((n) => n.meta.type !== "group" && !editor.getShape(shapeIdOf(n.id)))
    .map((n) => ({
      id: shapeIdOf(n.id),
      type: "geo" as const,
      x: n.x,
      y: n.y,
      props: {
        w: n.width,
        h: n.height,
        color: GROUP_COLOR[NODE_GROUP[n.meta.type]],
        size: "s" as const,
        richText: toRichText(n.text ?? ""),
      },
      meta: { readerType: n.meta.type },
    }));
  if (toCreate.length) editor.createShapes(toCreate);
}
