import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Vault } from "./vault.js";

/** Node 实现：CLI、MCP server、测试脚本用。 */
export class NodeVault implements Vault {
  constructor(readonly root: string) {}
  async readText(path: string) {
    try {
      return await readFile(join(this.root, path), "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  }
  async writeText(path: string, text: string) {
    const full = join(this.root, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, text, "utf8");
  }
  async list(dir: string) {
    try {
      return (await readdir(join(this.root, dir))).sort();
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
  }
  async readBytes(path: string) {
    try {
      return new Uint8Array(await readFile(join(this.root, path)));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  }
  async remove(path: string) {
    await rm(join(this.root, path), { force: true });
  }
}
