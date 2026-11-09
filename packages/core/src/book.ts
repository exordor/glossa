/**
 * 导入一本书（设计文档「流程 1 导入」）：选一个文件夹，按文件名 / front matter 排序，
 * 生成 book.json，新建画布时章节卡横向排开。原文件不修改；画布和产物都在 .canvas/。
 * 重复导入是幂等的：已有的 Source 保留 id（按路径匹配），只更新 hash、标题、顺序；新文件追加章节卡。
 */
import { parse as parseYaml } from "yaml";
import { CANVAS_DIR, loadCanvas, saveCanvas } from "./canvas-store.js";
import { contentHash } from "./hash.js";
import { newId } from "./ids.js";
import type { Registry } from "./registry.js";
import { stableStringify } from "./stable-json.js";
import type { Anchor, Book, ReaderNode, Source } from "./types.js";
import { SCHEMA_VERSION } from "./types.js";
import type { Vault } from "./vault.js";

export const BOOK_FILE = `${CANVAS_DIR}/book.json`;

/** 章节卡布局：横向排开（设计系统 size-card-chapter = 320）。 */
export const CHAPTER_LAYOUT = { width: 320, height: 120, gap: 80 } as const;

const BOOK_KEY_ORDER = ["schemaVersion", "id", "title", "authors", "sources"] as const;
const SOURCE_KEY_ORDER = ["id", "kind", "path", "hash", "order", "title"] as const;

export async function readBook(vault: Vault): Promise<Book | null> {
  const text = await vault.readText(BOOK_FILE);
  return text ? (JSON.parse(text) as Book) : null;
}

export async function writeBook(vault: Vault, book: Book): Promise<void> {
  const ordered = {
    ...book,
    sources: book.sources.map((s) => JSON.parse(stableStringify(s, SOURCE_KEY_ORDER))),
  };
  // 外层按 BOOK_KEY_ORDER；sources 内部顺序已排好，不再被字母序打乱
  const out: Record<string, unknown> = {};
  for (const k of BOOK_KEY_ORDER) if (ordered[k] !== undefined) out[k] = ordered[k];
  await vault.writeText(BOOK_FILE, JSON.stringify(out, null, "\t") + "\n");
}

/** front matter 里的 order / title；没有 front matter 返回空对象。 */
export function readFrontMatter(text: string): { order?: number; title?: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return {};
  try {
    const data = parseYaml(m[1] ?? "") as Record<string, unknown> | null;
    const out: { order?: number; title?: string } = {};
    if (typeof data?.order === "number") out.order = data.order;
    if (typeof data?.title === "string") out.title = data.title;
    return out;
  } catch {
    return {};
  }
}

function firstHeading(text: string): string | undefined {
  const m = /^#{1,6}\s+(.+?)\s*#*\s*$/m.exec(text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, ""));
  return m?.[1];
}

/** 文件名自然排序：01-a.md < 2-b.md < 10-c.md。 */
const collator = new Intl.Collator("zh-CN", { numeric: true, sensitivity: "base" });

export interface ImportResult {
  book: Book;
  added: Source[];
  updated: Source[];
  /** book.json 里有、文件夹里已经没有的来源（不删除，留给界面提示）。 */
  missing: Source[];
}

/** 章节卡锚定整个文件：偏移 0、引文为空。 */
function wholeFileAnchor(s: Source): Anchor {
  const quote = { exact: "", prefix: "", suffix: "" };
  return s.kind === "pdf"
    ? { kind: "pdf", sourceId: s.id, page: 1, bbox: [0, 0, 0, 0], quote, granularity: "block" }
    : { kind: "markdown", sourceId: s.id, headingPath: [], blockIndex: 0, start: 0, end: 0, fileHash: s.hash, quote, granularity: "block" };
}

export async function importBook(vault: Vault, registry: Registry, folderName: string): Promise<ImportResult> {
  const adapters = registry.list("source");
  const extOf = (p: string) => p.slice(p.lastIndexOf(".")).toLowerCase();
  const files = (await vault.list(""))
    .filter((f) => !f.startsWith("."))
    .filter((f) => adapters.some((a) => a.extensions.includes(extOf(f))));

  const prev = await readBook(vault);
  const prevByPath = new Map((prev?.sources ?? []).map((s) => [s.path, s]));

  const entries: Array<{ path: string; text: string; fm: ReturnType<typeof readFrontMatter> }> = [];
  for (const path of files) {
    const text = (await vault.readText(path)) ?? "";
    entries.push({ path, text, fm: readFrontMatter(text) });
  }
  entries.sort((a, b) => {
    const oa = a.fm.order ?? Number.POSITIVE_INFINITY;
    const ob = b.fm.order ?? Number.POSITIVE_INFINITY;
    return oa !== ob ? oa - ob : collator.compare(a.path, b.path);
  });

  const added: Source[] = [];
  const updated: Source[] = [];
  const sources: Source[] = entries.map((e, i) => {
    const adapter = adapters.find((a) => a.extensions.includes(extOf(e.path)))!;
    const old = prevByPath.get(e.path);
    const title = e.fm.title ?? firstHeading(e.text) ?? e.path.replace(/\.[^.]+$/, "");
    const s: Source = { id: old?.id ?? newId(), kind: adapter.kind, path: e.path, hash: contentHash(e.text), order: i, title };
    if (!old) added.push(s);
    else if (old.hash !== s.hash || old.title !== s.title || old.order !== s.order) updated.push(s);
    return s;
  });
  const present = new Set(files);
  const missing = (prev?.sources ?? []).filter((s) => !present.has(s.path));

  const book: Book = {
    schemaVersion: SCHEMA_VERSION,
    id: prev?.id ?? newId(),
    title: prev?.title ?? folderName,
    sources,
  };
  if (prev?.authors) book.authors = prev.authors;
  await writeBook(vault, book);

  // 章节卡：每个来源一张，已有的不动（用户可能拖过），新的接在最右边。
  const canvas = await loadCanvas(vault);
  const chapterOf = new Map(
    canvas.nodes.filter((n) => n.meta.type === "chapter" && n.meta.anchor).map((n) => [n.meta.anchor!.sourceId, n]),
  );
  let x = Math.max(
    -CHAPTER_LAYOUT.width - CHAPTER_LAYOUT.gap,
    ...canvas.nodes.filter((n) => n.meta.type === "chapter").map((n) => n.x),
  );
  for (const s of sources) {
    const existing = chapterOf.get(s.id);
    if (existing) {
      existing.text = s.title ?? s.path;
      continue;
    }
    x += CHAPTER_LAYOUT.width + CHAPTER_LAYOUT.gap;
    const node: ReaderNode = {
      id: newId(),
      x,
      y: 0,
      width: CHAPTER_LAYOUT.width,
      height: CHAPTER_LAYOUT.height,
      text: s.title ?? s.path,
      meta: {
        schemaVersion: SCHEMA_VERSION,
        type: "chapter",
        status: "idle",
        createdBy: "user",
        createdAt: new Date().toISOString(),
        anchor: wholeFileAnchor(s),
      },
    };
    canvas.nodes.push(node);
  }
  await saveCanvas(vault, canvas);
  return { book, added, updated, missing };
}

/** 界面状态（视口、阅读器位置），不是数据，删了只是回到默认。 */
export const VIEW_FILE = `${CANVAS_DIR}/view.json`;

export interface ViewState {
  schemaVersion: number;
  camera?: { x: number; y: number; z: number };
  openSourceId?: string;
  readerScroll?: number;
  /** 跟随阅读：换章时镜头移到这一章的节点群。不写时默认开。 */
  followReading?: boolean;
}

export async function readView(vault: Vault): Promise<ViewState | null> {
  const t = await vault.readText(VIEW_FILE);
  try {
    return t ? (JSON.parse(t) as ViewState) : null;
  } catch {
    return null;
  }
}

export async function writeView(vault: Vault, view: Omit<ViewState, "schemaVersion">): Promise<void> {
  await vault.writeText(VIEW_FILE, stableStringify({ schemaVersion: SCHEMA_VERSION, ...view }));
}
