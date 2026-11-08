import { resolveRelative } from "@reader/source-markdown/render";

/**
 * 开发期示例书的图片：Vite 把夹具里的图片打成 URL。
 * 「打开书文件夹」那一步换成 File System Access API 读出的 blob URL，接口不变。
 */
const urls = import.meta.glob("../../../fixtures/sample-book/**/*.{svg,png,jpg,jpeg,gif,webp}", {
  query: "?url",
  import: "default",
  eager: true,
}) as Record<string, string>;

const PREFIX = "../../../fixtures/sample-book/";

export function sampleBookAsset(chapterPath: string) {
  return (src: string): string | null => {
    if (/^https?:/i.test(src)) return src;
    const rel = resolveRelative(chapterPath, src);
    return rel ? (urls[PREFIX + rel] ?? null) : null;
  };
}
