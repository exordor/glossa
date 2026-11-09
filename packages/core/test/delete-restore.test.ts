/** 删节点与撤销恢复：连带连线、正文随墓碑保存、nodes/<id>.md 在保存时删除。 */
import { describe, expect, it } from "vitest";
import { MAIN_CANVAS, MemoryVault, NODES_DIR, Reader, parseNodeFile } from "../src/index.js";

async function setup() {
  const vault = new MemoryVault();
  const reader = new Reader(vault);
  await reader.open();
  const a = await reader.createNode({ type: "excerpt", x: 0, y: 0, width: 100, height: 100, text: "摘录" });
  const b = await reader.createNode({ type: "answer", x: 0, y: 200, width: 100, height: 100, body: "完整回答", status: "done" });
  const c = await reader.createNode({ type: "note", x: 200, y: 0, width: 100, height: 100, text: "批注" });
  const ab = await reader.connect(a.id, b.id, "derived");
  const bc = await reader.connect(b.id, c.id, "reference");
  await reader.save();
  return { vault, reader, a, b, c, ab, bc };
}

describe("deleteNodes / restore", () => {
  it("删节点连带删连线，保存时删掉 nodes/<id>.md", async () => {
    const { vault, reader, b, ab, bc } = await setup();
    const events: unknown[] = [];
    reader.events.on("node.deleted", (p) => events.push(p));
    const r = await reader.deleteNodes([b.id]);
    expect(r).toEqual({ nodes: [b.id], edges: [ab.id, bc.id] });
    expect(events).toEqual([r]);
    expect((await reader.listNodes()).map((n) => n.id)).not.toContain(b.id);
    expect(await reader.listEdges()).toEqual([]);
    await reader.save();
    expect(vault.files.has(`${NODES_DIR}/${b.id}.md`)).toBe(false);
    expect(vault.files.get(MAIN_CANVAS)).not.toContain(b.id);
  });

  it("保存后恢复：节点、正文、连线都回来，文件重新写出", async () => {
    const { vault, reader, b, ab, bc } = await setup();
    await reader.deleteNodes([b.id]);
    await reader.save();
    const r = await reader.restore({ nodes: [b.id], edges: [ab.id, bc.id] });
    expect(r.nodes.map((n) => n.id)).toEqual([b.id]);
    expect(r.edges.map((e) => e.id)).toEqual([ab.id, bc.id]);
    await reader.save();
    const md = vault.files.get(`${NODES_DIR}/${b.id}.md`)!;
    expect(parseNodeFile(md).body).toContain("完整回答");
    expect(parseNodeFile(md).meta.status).toBe("done");
  });

  it("保存前就恢复：不删文件", async () => {
    const { vault, reader, b } = await setup();
    await reader.deleteNodes([b.id]);
    await reader.restore({ nodes: [b.id] });
    await reader.save();
    expect(vault.files.has(`${NODES_DIR}/${b.id}.md`)).toBe(true);
  });

  it("连线只在两端都在时恢复；重复恢复是空操作", async () => {
    const { reader, a, b, ab, bc } = await setup();
    await reader.deleteNodes([a.id, b.id]);
    const first = await reader.restore({ nodes: [b.id], edges: [ab.id] });
    // a 还没回来：ab 不恢复；b—c 两端都在，跟着回来。
    expect(first.edges.map((e) => e.id)).toEqual([bc.id]);
    const second = await reader.restore({ nodes: [a.id, b.id], edges: [ab.id] });
    expect(second.nodes.map((n) => n.id)).toEqual([a.id]);
    expect(second.edges.map((e) => e.id)).toEqual([ab.id]);
    expect((await reader.restore({ nodes: [a.id], edges: [ab.id] })).nodes).toEqual([]);
  });

  it("只给节点 id 也能带回随它删掉的连线；单独删的连线不会跟着回来", async () => {
    const { reader, a, b, c, ab, bc } = await setup();
    await reader.deleteEdges([bc.id]);
    await reader.deleteNodes([b.id]);
    const r = await reader.restore({ nodes: [b.id] });
    expect(r.edges.map((e) => e.id)).toEqual([ab.id]);
    expect((await reader.listNodes()).map((n) => n.id)).toEqual([a.id, c.id, b.id]);
  });

  it("只删连线", async () => {
    const { reader, ab, bc } = await setup();
    expect(await reader.deleteEdges([ab.id])).toEqual([ab.id]);
    expect((await reader.listEdges()).map((e) => e.id)).toEqual([bc.id]);
    await reader.restore({ edges: [ab.id] });
    expect((await reader.listEdges()).map((e) => e.id)).toEqual([bc.id, ab.id]);
  });

  it("没保存过的正文也跟着墓碑走", async () => {
    const { reader } = await setup();
    const n = await reader.createNode({ type: "answer", x: 0, y: 0, width: 1, height: 1, body: "未保存的回答" });
    await reader.deleteNodes([n.id]);
    await reader.save();
    await reader.restore({ nodes: [n.id] });
    await reader.save();
    // 通过重新打开确认正文写进了文件
    const vault = (reader as unknown as { vault: MemoryVault }).vault;
    expect(parseNodeFile(vault.files.get(`${NODES_DIR}/${n.id}.md`)!).body).toContain("未保存的回答");
  });
});
