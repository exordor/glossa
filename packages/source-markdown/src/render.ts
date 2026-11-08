/**
 * Markdown → HAST（给阅读器渲染用），保留源文件偏移，锚点靠它：
 * - 每个原文文字节点包成 <span data-s data-e>，DOM 选区可以精确换算回源文件字符偏移。
 * - 顶层块带 data-block-s / data-block-e。
 * - 图片 src 交给 resolveAsset 解析（按 .md 所在目录，文件不复制）。
 * - 公式用 KaTeX 渲染（界面需引入 katex/dist/katex.min.css）。
 * 不依赖 React，界面层自己把 HAST 转成组件。
 */
import type { Element, ElementContent, Root as HastRoot, Text } from "hast";
import type { Root as MdRoot } from "mdast";
import rehypeKatex from "rehype-katex";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import type { SourceDoc } from "@reader/core";

export interface RenderOptions {
  /** 把 Markdown 里的相对图片路径解析成可显示的 URL；返回 null 表示找不到。 */
  resolveAsset?: (src: string) => string | null;
}

function isMath(el: Element): boolean {
  const cls = el.properties?.className;
  return Array.isArray(cls) && cls.some((c) => String(c).startsWith("math"));
}

function annotate(tree: HastRoot, opts: RenderOptions) {
  const visit = (node: HastRoot | Element, inMath: boolean) => {
    const children = node.children as ElementContent[];
    for (let i = 0; i < children.length; i++) {
      const child = children[i]!;
      if (child.type === "text") {
        const pos = (child as Text).position;
        if (inMath || pos?.start.offset === undefined || pos.end.offset === undefined) continue;
        children[i] = {
          type: "element",
          tagName: "span",
          properties: { dataS: pos.start.offset, dataE: pos.end.offset },
          children: [child],
        };
      } else if (child.type === "element") {
        if (child.tagName === "img" && opts.resolveAsset) {
          const src = String(child.properties?.src ?? "");
          const url = opts.resolveAsset(src);
          if (url) child.properties = { ...child.properties, src: url, dataSrc: src };
          else child.properties = { ...child.properties, dataMissing: true, dataSrc: src };
        }
        visit(child, inMath || isMath(child));
      }
    }
  };
  // 单独成段的图片 → <figure><img><figcaption>图注</figcaption></figure>
  tree.children = tree.children.map((node) => {
    if (node.type !== "element" || node.tagName !== "p") return node;
    const els = node.children.filter((c) => !(c.type === "text" && !c.value.trim()));
    const img = els[0];
    if (els.length !== 1 || img?.type !== "element" || img.tagName !== "img") return node;
    const alt = String(img.properties?.alt ?? "");
    const fig: Element = {
      type: "element",
      tagName: "figure",
      properties: {},
      children: alt ? [img, { type: "element", tagName: "figcaption", properties: {}, children: [{ type: "text", value: alt }] }] : [img],
    };
    if (node.position) fig.position = node.position;
    return fig;
  });
  for (const node of tree.children) {
    if (node.type === "element" && node.position?.start.offset !== undefined) {
      node.properties = { ...node.properties, dataBlockS: node.position.start.offset, dataBlockE: node.position.end.offset };
    }
  }
  visit(tree, false);
}

export async function renderToHast(doc: SourceDoc, opts: RenderOptions = {}): Promise<HastRoot> {
  const mdRoot = (doc.tree as { root: MdRoot }).root;
  const hast = (await unified().use(remarkRehype).run(structuredClone(mdRoot))) as HastRoot;
  annotate(hast, opts);
  return (await unified().use(rehypeKatex).run(hast)) as HastRoot;
}

/** 相对路径按章节文件所在目录解析，结果是相对书文件夹的路径（例如 images/a.svg）。 */
export function resolveRelative(chapterPath: string, src: string): string | null {
  if (/^[a-z]+:/i.test(src) || src.startsWith("/")) return null; // 绝对 URL 或绝对路径：交给调用方
  const base = chapterPath.split("/").slice(0, -1);
  for (const part of decodeURI(src).split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (!base.length) return null;
      base.pop();
    } else base.push(part);
  }
  return base.join("/");
}

/** 列出章节里引用的全部图片 src（按出现顺序去重），供界面预先加载成 URL。 */
export function collectImageSrcs(doc: SourceDoc): string[] {
  const out = new Set<string>();
  const walk = (n: { type: string; url?: string; children?: unknown[] }) => {
    if (n.type === "image" && n.url) out.add(n.url);
    for (const c of (n.children ?? []) as Array<typeof n>) walk(c);
  };
  walk((doc.tree as { root: MdRoot }).root as never);
  return [...out];
}
