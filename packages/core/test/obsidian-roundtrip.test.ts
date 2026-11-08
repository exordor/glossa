/**
 * Obsidian canvas 字段保留测试（设计文档「仍待定」第 1 条）。
 *
 * 风险：JSON Canvas 规范没要求第三方写回时保留未知字段，Obsidian 里拖一下再保存可能丢掉 x-reader。
 * 这里自动验证我们这一侧的两条保证：
 *   1. 我们自己读写时不丢任何字段（包括其他工具写的未知字段）。
 *   2. 即使第三方把所有非规范字段都删掉（最坏情况的 Obsidian 保存），也能从 nodes/<id>.md 完整重建。
 * 真实 Obsidian 的行为要人工拖一次：pnpm obsidian:fixture → 在 Obsidian 里拖动保存 → pnpm obsidian:check。
 */
import { describe, expect, it } from "vitest";
import {
  MAIN_CANVAS,
  NODES_DIR,
  X_READER,
  loadCanvas,
  nodesMissingMeta,
  parseCanvas,
  parseNodeFile,
  saveCanvas,
  serializeCanvas,
  type CanvasDoc,
} from "../src/index.js";
import { buildSampleCanvas } from "./fixture-canvas.js";

/** JSON Canvas 1.0 规范定义的字段。 */
const SPEC_NODE_KEYS = new Set([
  "id", "type", "x", "y", "width", "height", "color",
  "text", "file", "subpath", "url", "label", "background", "backgroundStyle",
]);
const SPEC_EDGE_KEYS = new Set(["id", "fromNode", "fromSide", "fromEnd", "toNode", "toSide", "toEnd", "color", "label"]);

/** 模拟最坏情况的第三方保存：只写回规范字段，并挪动一张卡片。 */
function simulateLossyEditorSave(json: string, moveId: string): string {
  const doc = JSON.parse(json) as CanvasDoc;
  const strip = (o: Record<string, unknown>, keep: Set<string>) =>
    Object.fromEntries(Object.entries(o).filter(([k]) => keep.has(k)));
  const out = {
    nodes: doc.nodes.map((n) => {
      const s = strip(n, SPEC_NODE_KEYS) as CanvasDoc["nodes"][number];
      if (s.id === moveId) s.x += 50;
      return s;
    }),
    edges: doc.edges.map((e) => strip(e, SPEC_EDGE_KEYS)),
  };
  return JSON.stringify(out);
}

describe("Obsidian canvas 字段保留", () => {
  it("我们写出的 main.canvas 每个节点都带 x-reader，每个节点都有 nodes/<id>.md", async () => {
    const { vault } = await buildSampleCanvas();
    const doc = parseCanvas((await vault.readText(MAIN_CANVAS))!);
    expect(doc.nodes).toHaveLength(5);
    expect(nodesMissingMeta(doc)).toEqual([]);
    for (const n of doc.nodes) {
      const md = await vault.readText(`${NODES_DIR}/${n.id}.md`);
      expect(md, `nodes/${n.id}.md`).not.toBeNull();
      expect(parseNodeFile(md!).meta).toEqual(n[X_READER]);
    }
    expect(doc.edges.every((e) => e[X_READER]?.role)).toBe(true);
  });

  it("读入再写回，保留其他工具写的未知字段（文档级、节点级、连线级）", async () => {
    const { vault, ids } = await buildSampleCanvas();
    const doc = parseCanvas((await vault.readText(MAIN_CANVAS))!);
    (doc as Record<string, unknown>)["x-other-tool"] = { keep: true };
    doc.nodes.find((n) => n.id === ids.note)!["x-obsidian-plugin"] = { pinned: 1 };
    doc.edges[0]!["x-edge-extra"] = "keep me";
    await vault.writeText(MAIN_CANVAS, serializeCanvas(doc));

    const loaded = await loadCanvas(vault);
    await saveCanvas(vault, loaded);
    const after = parseCanvas((await vault.readText(MAIN_CANVAS))!);
    expect((after as Record<string, unknown>)["x-other-tool"]).toEqual({ keep: true });
    expect(after.nodes.find((n) => n.id === ids.note)!["x-obsidian-plugin"]).toEqual({ pinned: 1 });
    expect(after.edges[0]!["x-edge-extra"]).toBe("keep me");
  });

  it("序列化稳定：连续保存两次字节一致，规范字段在前、x-reader 紧随", async () => {
    const { vault } = await buildSampleCanvas();
    const first = (await vault.readText(MAIN_CANVAS))!;
    await saveCanvas(vault, await loadCanvas(vault));
    expect(await vault.readText(MAIN_CANVAS)).toBe(first);
    const keys = Object.keys(parseCanvas(first).nodes[0]!);
    expect(keys.slice(0, 6)).toEqual(["id", "type", "x", "y", "width", "height"]);
    expect(keys.at(-1)).toBe(X_READER);
  });

  it("第三方只写回规范字段时，从 nodes/<id>.md 重建全部 x-reader，并保留新位置", async () => {
    const { vault, ids } = await buildSampleCanvas();
    const before = await loadCanvas(vault);
    const lossy = simulateLossyEditorSave((await vault.readText(MAIN_CANVAS))!, ids.excerpt);
    await vault.writeText(MAIN_CANVAS, lossy);
    expect(nodesMissingMeta(parseCanvas(lossy))).toHaveLength(5);

    const after = await loadCanvas(vault);
    expect(after.repaired.sort()).toEqual(Object.values(ids).sort());
    for (const n of before.nodes) {
      const m = after.nodes.find((x) => x.id === n.id)!;
      expect(m.meta).toEqual(n.meta);
      expect(m.x).toBe(n.id === ids.excerpt ? n.x + 50 : n.x);
    }
    // 连线 role：丢了 x-reader 时由 toEnd 推断，derived 有箭头、其余无箭头；reference 退化为 context（ADR 0001）。
    expect(after.edges.map((e) => e.role).sort()).toEqual(["context", "context", "derived"]);
    // 修复后再保存，main.canvas 恢复完整。
    await saveCanvas(vault, after);
    expect(nodesMissingMeta(parseCanvas((await vault.readText(MAIN_CANVAS))!))).toEqual([]);
  });

  it("用户在 Obsidian 里新建的卡片（无 x-reader、无 .md）按用户批注读入", async () => {
    const { vault } = await buildSampleCanvas();
    const doc = parseCanvas((await vault.readText(MAIN_CANVAS))!);
    doc.nodes.push({ id: "obsidian-new-card", type: "text", x: 0, y: 0, width: 200, height: 60, text: "我在 Obsidian 里加的" });
    await vault.writeText(MAIN_CANVAS, serializeCanvas(doc));
    const loaded = await loadCanvas(vault);
    const card = loaded.nodes.find((n) => n.id === "obsidian-new-card")!;
    expect(card.meta.type).toBe("note");
    expect(card.meta.createdBy).toBe("user");
    expect(card.text).toBe("我在 Obsidian 里加的");
  });

  it("回答正文保存在 nodes/<id>.md，再次保存不丢", async () => {
    const { vault, ids } = await buildSampleCanvas();
    await saveCanvas(vault, await loadCanvas(vault));
    const md = parseNodeFile((await vault.readText(`${NODES_DIR}/${ids.answer}.md`))!);
    expect(md.body).toContain("指自注意力机制 [^e1]");
  });
});
