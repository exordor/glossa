/** 内容 hash（FNV-1a 64 位，十六进制）。只用于判断文件是否变化，不用于安全。浏览器和 Node 同步可用。 */
export function contentHash(text: string): string {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < text.length; i++) {
    h ^= BigInt(text.charCodeAt(i));
    h = (h * prime) & mask;
  }
  return h.toString(16).padStart(16, "0");
}
