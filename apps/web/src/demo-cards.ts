/**
 * 示例书的演示卡片：一组完整问答（摘录 → 提问 → 回答）、一张批注、几种状态，
 * 让每种卡片和连线的样式在示例书里都看得到。只用于示例书（内存，不落盘）。
 * 第 5 步接入 AI 后，这些卡会由真实动作生成。
 */
import type { Book, Reader } from "@reader/core";
import { markdownAdapter } from "@reader/source-markdown";
import { CARD_SIZE } from "./canvas-sync";

const GAP = 40;

export async function seedDemoCards(reader: Reader, book: Book): Promise<void> {
  const nodes = await reader.listNodes();
  if (nodes.some((n) => n.meta.type !== "chapter")) return;
  const chapters = book.sources.map((s) => nodes.find((n) => n.meta.type === "chapter" && n.meta.anchor?.sourceId === s.id));

  const anchorOf = async (sourceIndex: number, phrase: string) => {
    const src = book.sources[sourceIndex];
    if (!src) return undefined;
    const text = await reader.readSource(src.id);
    const start = text?.text.indexOf(phrase) ?? -1;
    if (!text || start < 0) return undefined;
    const doc = await markdownAdapter.parse(src.id, text.text);
    return markdownAdapter.selectionToAnchor(doc, { kind: "text", start, end: start + phrase.length });
  };
  const below = (i: number) => {
    const c = chapters[i];
    return { x: c?.x ?? 0, y: (c?.y ?? 0) + (c?.height ?? 120) + 64 };
  };
  const size = (t: keyof typeof CARD_SIZE) => ({ width: CARD_SIZE[t]!.w, height: CARD_SIZE[t]!.h });

  // 第 1 章：一组完成的问答 + 一张用户批注（引用回答）
  {
    const p = below(0);
    const anchor = await anchorOf(0, "Each score is divided by the square root of the key dimension");
    const excerpt = await reader.createNode({ type: "excerpt", ...p, ...size("excerpt"), ...(anchor ? { anchor } : {}), text: anchor?.quote.exact ?? "" });
    let y = p.y + CARD_SIZE.excerpt!.h + GAP;
    const op = await reader.createNode({ type: "operation", x: p.x, y, ...size("operation"), label: "提问", text: "为什么要除以根号 d？不除会怎样？" });
    y += CARD_SIZE.operation!.h + GAP;
    const answer = await reader.createNode({
      type: "answer",
      x: p.x,
      y,
      ...size("answer"),
      createdBy: "ai",
      status: "done",
      version: 1,
      text: "维度越大，点积的数值越大，softmax 会被推到几乎只剩一个 1、其余是 0 的区域，梯度接近零。除以 √d 把方差拉回 1 左右，训练才稳定。",
    });
    await reader.connect(excerpt.id, op.id, "context");
    await reader.connect(op.id, answer.id, "derived");

    const noteAnchor = await anchorOf(0, "information from early tokens fades");
    const note = await reader.createNode({
      type: "note",
      x: p.x - CARD_SIZE.note!.w - 80,
      y: p.y,
      ...size("note"),
      ...(noteAnchor ? { anchor: noteAnchor } : {}),
      text: "这就是 RNN 的长距离依赖问题，和第 2 章的多头对照看。",
    });
    await reader.connect(note.id, answer.id, "reference", "对照");
  }

  // 第 2 章：进行中（外部 agent 发起）、失败、过期
  {
    const p = below(1);
    const src = book.sources[1];
    const text = src ? await reader.readSource(src.id) : null;
    const sentence = text?.text.split("\n").find((l) => l && !l.startsWith("#") && !l.startsWith("!") && !l.startsWith("$"))?.split(/(?<=[.。])\s/)[0];
    const a2 = sentence ? await anchorOf(1, sentence) : undefined;
    const excerpt = await reader.createNode({ type: "excerpt", ...p, ...size("excerpt"), ...(a2 ? { anchor: a2 } : {}), text: a2?.quote.exact ?? "", status: "stale" });
    let y = p.y + CARD_SIZE.excerpt!.h + GAP;
    const op = await reader.createNode({ type: "operation", x: p.x, y, ...size("operation"), label: "解释", text: "多头和单头相比，多出来的是什么？", createdBy: "agent" });
    y += CARD_SIZE.operation!.h + GAP;
    const running = await reader.createNode({ type: "answer", x: p.x, y, ...size("answer"), createdBy: "agent", status: "running", text: "正在生成…" });
    await reader.connect(excerpt.id, op.id, "context");
    await reader.connect(op.id, running.id, "derived");
    y += CARD_SIZE.answer!.h + GAP;
    const failed = await reader.createNode({
      type: "answer",
      x: p.x,
      y,
      ...size("answer"),
      createdBy: "ai",
      status: "failed",
      text: "请求超时（30 秒）。可以重试，或在设置里换一个模型。",
    });
    await reader.connect(op.id, failed.id, "derived");
  }
}
