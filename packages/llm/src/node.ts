/** @reader/llm/node：只在 Node 里可用的部分（依赖 node:fs）。 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stableStringify } from "@reader/core";
import { RECORDING_KEY_ORDER, type Recording, type RecordingStore } from "./record-replay.js";

/** fixtures/recordings/<promptHash>.json 文件存储。 */
export class FileRecordingStore implements RecordingStore {
  constructor(readonly dir: string) {}
  async get(hash: string): Promise<Recording | null> {
    if (!/^[0-9a-f]{64}$/.test(hash)) return null;
    try {
      return JSON.parse(await readFile(join(this.dir, `${hash}.json`), "utf8")) as Recording;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  }
  async put(rec: Recording): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(join(this.dir, `${rec.promptHash}.json`), stableStringify(rec, RECORDING_KEY_ORDER), "utf8");
  }
}

/** 仓库里的 fixtures/recordings 绝对路径。 */
export const REPO_RECORDINGS_DIR = fileURLToPath(new URL("../../../fixtures/recordings/", import.meta.url));
