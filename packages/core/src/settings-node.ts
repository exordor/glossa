/**
 * NodeSettingsStore：~/.reader/settings.json（环境变量 READER_HOME 可覆盖 ~/.reader，测试和 CI 用）。
 * CLI、MCP、dev bridge 用。密钥不在这里：密钥由 dev bridge（钥匙串或 credentials.json）管理。
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { type GlobalSettings, type SettingsStore, defaultSettings, parseSettings, serializeSettings } from "./settings.js";

/** ~/.reader，或 $READER_HOME。 */
export function readerHome(env: Record<string, string | undefined> = process.env): string {
  return env.READER_HOME || join(homedir(), ".reader");
}

export class NodeSettingsStore implements SettingsStore {
  readonly path: string;
  constructor(readonly home: string = readerHome()) {
    this.path = join(home, "settings.json");
  }

  /** 文件不存在：返回默认值，不写盘（第一次保存时才建）。解析失败：备份为 settings.json.bak-<时间戳>，返回默认值。 */
  async load(): Promise<GlobalSettings> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return defaultSettings();
      throw e;
    }
    try {
      return parseSettings(text);
    } catch {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      await rename(this.path, `${this.path}.bak-${stamp}`);
      return defaultSettings();
    }
  }

  /** 先写临时文件再改名，避免写一半留下坏文件。 */
  async save(settings: GlobalSettings): Promise<void> {
    await mkdir(this.home, { recursive: true });
    const tmp = `${this.path}.tmp-${process.pid}`;
    await writeFile(tmp, serializeSettings(settings), "utf8");
    await rename(tmp, this.path);
  }
}
