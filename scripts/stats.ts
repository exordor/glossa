/**
 * 看一本书的 v0.1 出口指标（设计文档「成功指标」）：读 <书文件夹>/.canvas/stats.jsonl 和 runs/*.jsonl。
 *
 *   pnpm stats -- ~/books/attention
 *
 * 只读，不联网。
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type RunRecord, type StatRecord, summarizeStats } from "@reader/core";

const dir = process.argv.slice(2).find((a) => a !== "--");
if (!dir) {
  console.error("用法：pnpm stats -- <书文件夹>");
  process.exit(1);
}

function lines<T>(path: string): T[] {
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  return text.split("\n").flatMap((l) => {
    try {
      return l.trim() ? [JSON.parse(l) as T] : [];
    } catch {
      return [];
    }
  });
}

const canvas = join(dir, ".canvas");
const stats = lines<StatRecord>(join(canvas, "stats.jsonl"));
let runFiles: string[] = [];
try {
  runFiles = readdirSync(join(canvas, "runs")).filter((f) => f.endsWith(".jsonl"));
} catch {
  // 还没有运行记录
}
const runs = runFiles.flatMap((f) => lines<RunRecord>(join(canvas, "runs", f)));
const s = summarizeStats(stats);
const pct = (x: number | null) => (x === null ? "—" : `${Math.round(x * 100)}%`);
const cost = runs.reduce((n, r) => n + (r.costUsd ?? 0), 0);
console.log(`提问 ${s.actions} 次，其中追问 ${s.followups} 次，追问率 ${pct(s.followupRate)}（门槛 ≥ 30%）`);
console.log(`跳回原文 ${s.locates} 次（门槛：每章 ≥ 3）`);
console.log(`选中到首字中位数 ${s.firstTokenMedianMs === null ? "—" : `${(s.firstTokenMedianMs / 1000).toFixed(1)} s`}（门槛 < 3 s）`);
console.log(
  `AI 调用 ${runs.length} 次，成功 ${runs.filter((r) => r.ok).length} 次，引用没找到 ${runs.reduce((n, r) => n + r.citationErrors, 0)} 处，费用约 $${cost.toFixed(4)}`,
);
