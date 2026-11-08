/** 极简 Markdown 的纯文本部分（无 JSX，便于测试）。 */
const BULLET = /^\s*[-*•]\s+/;
const ORDERED = /^\s*(\d+)[.、)]\s+/;
const HEADING = /^\s*#{1,6}\s+/;

/** 卡片用：一段文字，换行保留。 */
export function compactText(text: string): string {
  return text
    .split("\n")
    .map((l) => l.replace(HEADING, "").replace(BULLET, "• "))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}


export type Block = { kind: "p" | "h"; text: string } | { kind: "ul" | "ol"; items: string[]; start?: number };

export function blocks(text: string): Block[] {
  const out: Block[] = [];
  for (const raw of text.replace(/\r/g, "").split("\n")) {
    const line = raw.trimEnd();
    const last = out.at(-1);
    if (!line.trim()) {
      out.push({ kind: "p", text: "" });
      continue;
    }
    const ol = ORDERED.exec(line);
    if (BULLET.test(line)) {
      const item = line.replace(BULLET, "");
      if (last?.kind === "ul") last.items.push(item);
      else out.push({ kind: "ul", items: [item] });
    } else if (ol) {
      const item = line.replace(ORDERED, "");
      if (last?.kind === "ol") last.items.push(item);
      else out.push({ kind: "ol", items: [item], start: Number(ol[1]) });
    } else if (HEADING.test(line)) {
      out.push({ kind: "h", text: line.replace(HEADING, "") });
    } else if (last?.kind === "p" && last.text) {
      last.text += "\n" + line;
    } else {
      out.push({ kind: "p", text: line });
    }
  }
  return out.filter((b) => !(b.kind === "p" && !b.text));
}

