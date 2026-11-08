/**
 * Obsidian 真实 round-trip 实测（设计文档「仍待定」第 1 条）。自动测试只能模拟最坏情况，这个脚本测真的 Obsidian。
 *
 *   pnpm obsidian:fixture [目录]   生成一个 Obsidian vault，里面有 roundtrip.canvas（每个节点都带 x-reader）
 *   → 在 Obsidian 里「打开文件夹作为仓库」，打开 roundtrip.canvas，拖动任意一张卡片，等它自动保存
 *   pnpm obsidian:check [目录]     读回来，列出哪些节点 / 连线丢了 x-reader 或其他字段
 *
 * 注意：Obsidian 不显示以点开头的文件夹，所以真实书文件夹里的 .canvas/main.canvas 在 Obsidian 里看不见。
 * 这里把画布放在 vault 根目录，专门用来测字段保留。
 */
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { MAIN_CANVAS, X_READER, parseCanvas } from "@reader/core";
import { NodeVault } from "@reader/core/node";
import { buildSampleCanvas } from "../packages/core/test/fixture-canvas.js";

const [mode, dirArg] = process.argv.slice(2);
const dir = resolve(dirArg ?? "tmp/obsidian-roundtrip");
const CANVAS = "roundtrip.canvas";
const EXPECTED = "roundtrip.expected.json";

async function make() {
  const { vault: mem } = await buildSampleCanvas();
  const out = new NodeVault(dir);
  const canvas = (await mem.readText(MAIN_CANVAS))!;
  await out.writeText(CANVAS, canvas);
  await out.writeText(EXPECTED, canvas);
  for (const [path, text] of mem.files) if (path !== MAIN_CANVAS) await out.writeText(path, text);
  console.log(`已生成 ${join(dir, CANVAS)}`);
  console.log("下一步：用 Obsidian 打开这个文件夹 → 打开 roundtrip.canvas → 拖动一张卡片 → 等 2 秒 → pnpm obsidian:check");
}

async function check() {
  const expected = parseCanvas(await readFile(join(dir, EXPECTED), "utf8"));
  const actual = parseCanvas(await readFile(join(dir, CANVAS), "utf8"));
  const report: string[] = [];
  let moved = 0;
  for (const e of expected.nodes) {
    const a = actual.nodes.find((n) => n.id === e.id);
    if (!a) {
      report.push(`节点 ${e.id}：被删除`);
      continue;
    }
    if (a.x !== e.x || a.y !== e.y) moved++;
    const lost = Object.keys(e).filter((k) => !(k in a));
    if (lost.length) report.push(`节点 ${e.id}：丢失 ${lost.join(", ")}`);
    else if (JSON.stringify(a[X_READER]) !== JSON.stringify(e[X_READER])) report.push(`节点 ${e.id}：x-reader 内容被改写`);
  }
  for (const e of expected.edges) {
    const a = actual.edges.find((x) => x.id === e.id);
    if (!a) report.push(`连线 ${e.id}：被删除`);
    else {
      const lost = Object.keys(e).filter((k) => !(k in a));
      if (lost.length) report.push(`连线 ${e.id}：丢失 ${lost.join(", ")}`);
    }
  }
  if (moved === 0) console.log("提醒：没有检测到卡片被移动，确认在 Obsidian 里拖过并已保存。");
  if (report.length === 0) {
    console.log(`结果：保留。${expected.nodes.length} 个节点、${expected.edges.length} 条连线的所有字段都在（${moved} 个节点被移动）。`);
  } else {
    console.log("结果：有字段丢失（设计上会从 nodes/<id>.md 重建）：");
    for (const line of report) console.log("  - " + line);
    process.exitCode = 1;
  }
}

if (mode === "make") await make();
else if (mode === "check") await check();
else {
  console.error("用法：tsx scripts/obsidian-roundtrip.ts make|check [目录]");
  process.exitCode = 2;
}
