/**
 * 文件访问抽象。浏览器开发期用 File System Access API，Tauri / Node（CLI、MCP、测试）用原生 fs。
 * 核心只认这个接口，所以同一套逻辑在三处跑。路径一律用 "/" 分隔、相对书文件夹。
 */
export interface Vault {
  readText(path: string): Promise<string | null>;
  writeText(path: string, text: string): Promise<void>;
  list(dir: string): Promise<string[]>;
  remove(path: string): Promise<void>;
  /** 读二进制（图片、PDF）。不存在返回 null。 */
  readBytes(path: string): Promise<Uint8Array | null>;
}

/** 内存实现：测试和临时画布用。 */
export class MemoryVault implements Vault {
  readonly files = new Map<string, string>();
  readonly binaries = new Map<string, Uint8Array>();

  constructor(initial: Record<string, string> = {}) {
    for (const [k, v] of Object.entries(initial)) this.files.set(k, v);
  }
  async readText(path: string) {
    return this.files.get(path) ?? null;
  }
  async writeText(path: string, text: string) {
    this.files.set(path, text);
  }
  async list(dir: string) {
    const prefix = dir === "" ? "" : dir.endsWith("/") ? dir : dir + "/";
    return [...new Set([...this.files.keys(), ...this.binaries.keys()])]
      .filter((k) => k.startsWith(prefix) && !k.slice(prefix.length).includes("/"))
      .map((k) => k.slice(prefix.length))
      .sort();
  }
  async remove(path: string) {
    this.files.delete(path);
    this.binaries.delete(path);
  }
  async readBytes(path: string) {
    const b = this.binaries.get(path);
    if (b) return b;
    const t = this.files.get(path);
    return t === undefined ? null : new TextEncoder().encode(t);
  }
}
