import type { SourceDoc, Vault } from "@reader/core";
import { collectImageSrcs, resolveRelative } from "@reader/source-markdown/render";

const MIME: Record<string, string> = {
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

/**
 * 把章节引用的图片从书文件夹读出来，做成 blob URL。返回同步的 resolveAsset 和释放函数。
 * 路径按 .md 所在目录解析，文件不复制；http(s) 图片原样使用。
 */
export async function loadChapterAssets(vault: Vault, chapterPath: string, doc: SourceDoc) {
  const urls = new Map<string, string>();
  for (const src of collectImageSrcs(doc)) {
    if (/^https?:/i.test(src)) {
      urls.set(src, src);
      continue;
    }
    const rel = resolveRelative(chapterPath, src);
    const bytes = rel ? await vault.readBytes(rel) : null;
    if (!rel || !bytes) continue;
    const ext = rel.slice(rel.lastIndexOf(".") + 1).toLowerCase();
    urls.set(src, URL.createObjectURL(new Blob([bytes as BlobPart], { type: MIME[ext] ?? "application/octet-stream" })));
  }
  return {
    resolveAsset: (src: string) => urls.get(src) ?? null,
    dispose: () => {
      for (const u of urls.values()) if (u.startsWith("blob:")) URL.revokeObjectURL(u);
    },
  };
}
