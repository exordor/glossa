import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BOOK_FILE, MAIN_CANVAS, MemoryVault, Reader, readFrontMatter, type SourceAdapter } from "../src/index.js";

/** 只为导入测试注册一个假的 Markdown 适配器（core 不依赖 source-markdown）。 */
const fakeMd = { id: "markdown", kind: "markdown", extensions: [".md"] } as unknown as SourceAdapter;

function sampleBookVault() {
  const dir = new URL("../../../fixtures/sample-book/", import.meta.url);
  const files: Record<string, string> = {};
  for (const f of readdirSync(dir)) if (f.endsWith(".md")) files[f] = readFileSync(new URL(f, dir), "utf8");
  return new MemoryVault(files);
}

async function openReader(vault: MemoryVault) {
  const r = new Reader(vault);
  r.registry.register("source", fakeMd);
  await r.open();
  return r;
}

describe("导入一本书", () => {
  it("按文件名自然排序，标题取第一个标题，章节卡横向排开", async () => {
    const vault = sampleBookVault();
    const r = await openReader(vault);
    const res = await r.importBook("sample-book");
    expect(res.book.sources.map((s) => s.title)).toEqual(["第 1 章 注意力", "第 2 章 多头注意力", "第 3 章 位置编码"]);
    expect(res.added).toHaveLength(3);
    const chapters = (await r.listNodes()).filter((n) => n.meta.type === "chapter");
    expect(chapters.map((n) => n.x)).toEqual([0, 400, 800]);
    expect(chapters.every((n) => n.y === 0)).toBe(true);
    expect(await vault.readText(BOOK_FILE)).toContain('"schemaVersion": 1');
    expect(await vault.readText(MAIN_CANVAS)).not.toBeNull();
  });

  it("重复导入是幂等的：id 不变，拖过的章节卡不动；新文件追加在最右边", async () => {
    const vault = sampleBookVault();
    const r = await openReader(vault);
    const first = await r.importBook("sample-book");
    const ch1 = (await r.listNodes()).find((n) => n.text === "第 1 章 注意力")!;
    await r.moveNode(ch1.id, 50, 300);
    await r.save();

    await vault.writeText("04-new.md", "# 第 4 章 新章\n\n正文。\n");
    const second = await r.importBook("sample-book");
    expect(second.added.map((s) => s.title)).toEqual(["第 4 章 新章"]);
    expect(second.book.sources.slice(0, 3).map((s) => s.id)).toEqual(first.book.sources.map((s) => s.id));
    expect(second.book.id).toBe(first.book.id);
    const nodes = await r.listNodes();
    const moved = nodes.find((n) => n.id === ch1.id)!;
    expect([moved.x, moved.y, moved.meta.pinned]).toEqual([50, 300, true]);
    expect(nodes.filter((n) => n.meta.type === "chapter").map((n) => n.x).sort((a, b) => a - b)).toEqual([50, 400, 800, 1200]);
  });

  it("front matter 的 order / title 优先于文件名和标题；删掉的文件列为 missing", async () => {
    const vault = new MemoryVault({
      "b.md": "---\norder: 1\ntitle: 前言\n---\n# B\n",
      "a.md": "# A 章\n",
      ".hidden.md": "# 不导入\n",
      "notes.txt": "不导入",
    });
    const r = await openReader(vault);
    const res = await r.importBook("x");
    expect(res.book.sources.map((s) => [s.path, s.title])).toEqual([
      ["b.md", "前言"],
      ["a.md", "A 章"],
    ]);
    await vault.remove("a.md");
    expect((await r.importBook("x")).missing.map((s) => s.path)).toEqual(["a.md"]);
  });

  it("readFrontMatter 容错", () => {
    expect(readFrontMatter("# 无")).toEqual({});
    expect(readFrontMatter("---\n: bad: [\n---\n")).toEqual({});
  });

  it("readSource 按 id 读全文；视口状态可存取", async () => {
    const vault = sampleBookVault();
    const r = await openReader(vault);
    const { book } = await r.importBook("sample-book");
    expect((await r.readSource(book.sources[1]!.id))?.text).toContain("Multi-head attention");
    await r.saveView({ camera: { x: 1, y: 2, z: 0.5 }, openSourceId: book.sources[1]!.id });
    expect((await r.getView())?.camera).toEqual({ x: 1, y: 2, z: 0.5 });
    // 只改打开的章节时，视口保留
    await r.saveView({ openSourceId: book.sources[0]!.id });
    expect(await r.getView()).toMatchObject({ camera: { x: 1, y: 2, z: 0.5 }, openSourceId: book.sources[0]!.id });
  });

  it("updateNode 改文字与状态，正文在 save() 时写进 nodes/<id>.md", async () => {
    const vault = sampleBookVault();
    const r = await openReader(vault);
    await r.importBook("sample-book");
    const n = await r.createNode({ type: "answer", x: 0, y: 0, width: 360, height: 148, createdBy: "ai", status: "running", text: "" });
    expect(await r.updateNode("不存在", { text: "x" })).toBeNull();
    await r.updateNode(n.id, { text: "部分" });
    const done = await r.updateNode(n.id, { text: "完整回答", status: "done", body: "完整回答\n\n第二段" });
    expect([done?.text, done?.meta.status]).toEqual(["完整回答", "done"]);
    await r.save();
    const file = await vault.readText(`.canvas/nodes/${n.id}.md`);
    expect(file).toContain("status: done");
    expect(file).toContain("第二段");
  });
});
