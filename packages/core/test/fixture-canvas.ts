import { MemoryVault, Reader, type MarkdownAnchor } from "../src/index.js";

export const sampleAnchor: MarkdownAnchor = {
  kind: "markdown",
  sourceId: "01JSRC0000000000000000CH01",
  headingPath: ["第 1 章 注意力", "1.2 自注意力"],
  blockIndex: 3,
  start: 120,
  end: 158,
  fileHash: "0123456789abcdef",
  quote: { exact: "attention is all you need", prefix: "the claim that ", suffix: " is too strong" },
  granularity: "phrase",
};

/** 一次提问的三个节点（摘录 → 操作 → 回答）+ 一张批注 + 一个分组，覆盖所有 role。 */
export async function buildSampleCanvas() {
  const vault = new MemoryVault();
  const reader = new Reader(vault);
  await reader.open();
  const qa = "01JQA00000000000000000QA01";
  const excerpt = await reader.createNode({
    type: "excerpt", x: 400, y: 0, width: 320, height: 120,
    text: "attention is all you need", anchor: sampleAnchor, parentQA: qa,
  });
  const op = await reader.createNode({
    type: "operation", x: 400, y: 160, width: 280, height: 80,
    text: "这里的 attention 指什么？", createdBy: "user", parentQA: qa,
  });
  const answer = await reader.createNode({
    type: "answer", x: 400, y: 280, width: 360, height: 140,
    text: "指自注意力机制。", body: "## 结论\n\n指自注意力机制 [^e1]。\n", createdBy: "ai", parentQA: qa,
  });
  const note = await reader.createNode({
    type: "note", x: 800, y: 0, width: 240, height: 100, text: "和第 3 章对照", createdBy: "agent",
  });
  const group = await reader.createNode({ type: "group", x: 360, y: -40, width: 720, height: 500, label: "注意力" });
  await reader.connect(excerpt.id, op.id, "context");
  await reader.connect(op.id, answer.id, "derived");
  await reader.connect(note.id, excerpt.id, "reference", "包含");
  await reader.save();
  return { vault, reader, ids: { excerpt: excerpt.id, op: op.id, answer: answer.id, note: note.id, group: group.id } };
}
