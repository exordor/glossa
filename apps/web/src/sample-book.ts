import { MemoryVault } from "@reader/core";

/** 示例书：从仓库 fixtures 打包进来，存在内存里（改动不落盘）。 */
const texts = import.meta.glob("../../../fixtures/sample-book/*.md", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const images = import.meta.glob("../../../fixtures/sample-book/**/*.{svg,png,jpg,jpeg,gif,webp}", {
  query: "?url",
  import: "default",
  eager: true,
}) as Record<string, string>;
const PREFIX = "../../../fixtures/sample-book/";

export async function sampleBookVault(): Promise<MemoryVault> {
  const v = new MemoryVault();
  for (const [k, t] of Object.entries(texts)) v.files.set(k.slice(PREFIX.length), t);
  for (const [k, url] of Object.entries(images)) {
    const buf = new Uint8Array(await (await fetch(url)).arrayBuffer());
    v.binaries.set(k.slice(PREFIX.length), buf);
  }
  return v;
}
