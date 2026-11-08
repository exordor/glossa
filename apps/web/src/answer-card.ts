/** 回答卡的显示内容（纯函数，不依赖 tldraw / JSX，便于测试）。 */
import { type ReaderNode, parseAnswer } from "@reader/core";
import { citeSummary } from "./cite";

/**
 * 回答卡：结论做标题，要点 / 步骤做正文（流式时结论先出现）。失败的卡、没有列表的回答照原文显示。
 */
export function answerParts(node: ReaderNode): { title: string; body: string; cite: string; citeWarn: boolean } {
  const text = node.text ?? "";
  const cite = citeSummary(node.meta.citations ?? []);
  const c = { cite: cite?.short ?? "", citeWarn: cite?.warn ?? false };
  if (node.meta.status === "failed") return { title: "", body: text, ...c };
  const a = parseAnswer(text, node.meta.depth ?? "points");
  const items = a.steps?.map((s, i) => `${i + 1}. ${s}`) ?? a.points?.map((s) => `- ${s}`) ?? [];
  // 只有一段话（一句话深度、旧回答）：照正文显示，不做标题。
  if (!a.summary || !items.length) return { title: "", body: text, ...c };
  return { title: a.summary.replace(/\*\*|__/g, ""), body: items.join("\n"), ...c };
}
