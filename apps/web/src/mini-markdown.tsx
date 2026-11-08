/**
 * 回答文字的极简 Markdown 显示：模型常用的加粗、斜体、行内代码、列表、标题。
 * 不解析 HTML（全部当文字），不引入完整 Markdown 管线——卡片要同步渲染、可截断。
 * - compact：卡片里用。保留换行（pre-line），列表符号换成「•」，标题只加粗，便于多行截断。
 * - full：就地卡、面板里用。段落、有序 / 无序列表成块显示。
 */
import { Fragment, type ReactNode } from "react";
import { blocks, compactText } from "./mini-markdown-text";

const INLINE = /(\*\*[^*\n]+\*\*|__[^_\n]+__|`[^`\n]+`|\*[^*\n]+\*|「[^「」\n]{2,}」)/g;

/** 引用校验结果：原话 → 是否在原文里找到。不给就不标。 */
export type CiteMap = ReadonlyMap<string, boolean>;

export function inline(text: string, cites?: CiteMap): ReactNode[] {
  return text.split(INLINE).map((t, i) => {
    if (!t) return null;
    if (t.startsWith("「") && t.endsWith("」")) {
      const ok = cites?.get(t.slice(1, -1).trim());
      if (ok === undefined) return <Fragment key={i}>{t}</Fragment>;
      return (
        <span key={i} className="md-cite" data-verified={ok} title={ok ? "原文里有这句话" : "原文里没找到这句话，可能是模型改写或编造的"}>
          {t}
        </span>
      );
    }
    if ((t.startsWith("**") && t.endsWith("**")) || (t.startsWith("__") && t.endsWith("__")))
      return <strong key={i}>{t.slice(2, -2)}</strong>;
    if (t.startsWith("`") && t.endsWith("`") && t.length > 2) return <code key={i}>{t.slice(1, -1)}</code>;
    if (t.startsWith("*") && t.endsWith("*") && t.length > 2) return <em key={i}>{t.slice(1, -1)}</em>;
    return <Fragment key={i}>{t}</Fragment>;
  });
}

export function MarkdownCompact({ text }: { text: string }) {
  const lines = compactText(text).split("\n");
  return (
    <>
      {lines.map((l, i) => (
        <Fragment key={i}>
          {i > 0 && "\n"}
          {inline(l)}
        </Fragment>
      ))}
    </>
  );
}

export function MarkdownFull({ text, cites }: { text: string; cites?: CiteMap }) {
  return (
    <>
      {blocks(text).map((b, i) => {
        if (b.kind === "ul")
          return (
            <ul key={i}>
              {b.items.map((t, j) => (
                <li key={j}>{inline(t, cites)}</li>
              ))}
            </ul>
          );
        if (b.kind === "ol")
          return (
            <ol key={i} start={b.start}>
              {b.items.map((t, j) => (
                <li key={j}>{inline(t, cites)}</li>
              ))}
            </ol>
          );
        if (b.kind === "h")
          return (
            <p key={i} className="md-heading">
              <strong>{inline(b.text, cites)}</strong>
            </p>
          );
        return <p key={i}>{inline("text" in b ? b.text : "", cites)}</p>;
      })}
    </>
  );
}
