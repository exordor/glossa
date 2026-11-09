/**
 * NodeVocabStore：~/.reader/vocab.jsonl（READER_HOME 可覆盖）。追加写，一次查词一行。
 * CLI、MCP、dev bridge 用。
 */
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { readerHome } from "./settings-node.js";
import { type VocabRecord, type VocabStore, parseVocabLines, serializeVocabRecord } from "./vocab.js";

export class NodeVocabStore implements VocabStore {
  readonly path: string;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(readonly home: string = readerHome()) {
    this.path = join(home, "vocab.jsonl");
  }

  async list(): Promise<VocabRecord[]> {
    try {
      return parseVocabLines(await readFile(this.path, "utf8"));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
  }

  /** 排队追加，避免并发时两行交错。 */
  append(record: VocabRecord): Promise<void> {
    const run = this.queue.then(async () => {
      await mkdir(this.home, { recursive: true });
      await appendFile(this.path, `${serializeVocabRecord(record)}\n`, "utf8");
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
}
