/**
 * File System Access API 实现的 Vault（开发期纯 Web，仅 Chromium）。发布时 Tauri 换成原生 fs，接口不变。
 * 路径用 "/" 分隔、相对书文件夹。
 */
import type { Vault } from "@reader/core";

type Dir = FileSystemDirectoryHandle;

async function walk(root: Dir, parts: string[], create: boolean): Promise<Dir | null> {
  let dir = root;
  for (const p of parts) {
    try {
      dir = await dir.getDirectoryHandle(p, { create });
    } catch {
      return null;
    }
  }
  return dir;
}

function split(path: string): { dirs: string[]; name: string } {
  const parts = path.split("/").filter(Boolean);
  return { dirs: parts.slice(0, -1), name: parts.at(-1) ?? "" };
}

export class FsAccessVault implements Vault {
  constructor(readonly root: Dir) {}

  get name() {
    return this.root.name;
  }

  private async file(path: string): Promise<File | null> {
    const { dirs, name } = split(path);
    const dir = await walk(this.root, dirs, false);
    if (!dir) return null;
    try {
      return await (await dir.getFileHandle(name)).getFile();
    } catch {
      return null;
    }
  }

  async readText(path: string) {
    const f = await this.file(path);
    return f ? f.text() : null;
  }

  async readBytes(path: string) {
    const f = await this.file(path);
    return f ? new Uint8Array(await f.arrayBuffer()) : null;
  }

  async writeText(path: string, text: string) {
    const { dirs, name } = split(path);
    const dir = await walk(this.root, dirs, true);
    if (!dir) throw new Error(`无法创建目录：${dirs.join("/")}`);
    const handle = await dir.getFileHandle(name, { create: true });
    const w = await handle.createWritable();
    await w.write(text);
    await w.close();
  }

  async list(dirPath: string) {
    const dir = await walk(this.root, dirPath.split("/").filter(Boolean), false);
    if (!dir) return [];
    const names: string[] = [];
    for await (const [name, h] of (dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) {
      if (h.kind === "file") names.push(name);
    }
    return names.sort();
  }

  async remove(path: string) {
    const { dirs, name } = split(path);
    const dir = await walk(this.root, dirs, false);
    await dir?.removeEntry(name).catch(() => undefined);
  }
}

/* ---- 记住上次打开的文件夹（只是便利：IndexedDB 存目录句柄，打开时需重新授权） ---- */

const DB = "glossa";
const STORE = "handles";

function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function rememberFolder(handle: Dir): Promise<void> {
  try {
    const d = await db();
    d.transaction(STORE, "readwrite").objectStore(STORE).put(handle, "last");
  } catch {
    /* 隐私模式等情况下忽略 */
  }
}

export async function lastFolder(): Promise<Dir | null> {
  try {
    const d = await db();
    return await new Promise((resolve) => {
      const req = d.transaction(STORE).objectStore(STORE).get("last");
      req.onsuccess = () => resolve((req.result as Dir | undefined) ?? null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

export async function ensurePermission(handle: Dir): Promise<boolean> {
  const h = handle as Dir & {
    queryPermission(o: { mode: string }): Promise<PermissionState>;
    requestPermission(o: { mode: string }): Promise<PermissionState>;
  };
  if ((await h.queryPermission({ mode: "readwrite" })) === "granted") return true;
  return (await h.requestPermission({ mode: "readwrite" })) === "granted";
}

export function pickFolder(): Promise<Dir> {
  return (window as unknown as { showDirectoryPicker(o: { mode: string }): Promise<Dir> }).showDirectoryPicker({ mode: "readwrite" });
}

export const fsAccessSupported = () => "showDirectoryPicker" in window;
