/** 生词本经 dev bridge 读写 ~/.reader/vocab.jsonl；没有 bridge（生产构建、示例书离线）时退回内存。 */
import { MemoryVocabStore, type VocabRecord, type VocabStore } from "@reader/core";
import { BRIDGE_HEADER } from "@reader/llm";

const headers = (extra: Record<string, string> = {}) => ({ [BRIDGE_HEADER]: "1", ...extra });

export class HttpVocabStore implements VocabStore {
  private fallback = new MemoryVocabStore();
  private bridge: boolean | null = null;

  async list(): Promise<VocabRecord[]> {
    try {
      const res = await fetch("/__glossa/vocab", { headers: headers() });
      if (!res.ok || res.headers.get(BRIDGE_HEADER) !== "1") throw new Error(`HTTP ${res.status}`);
      this.bridge = true;
      return ((await res.json()) as { records: VocabRecord[] }).records;
    } catch {
      this.bridge = false;
      return this.fallback.list();
    }
  }

  async append(record: VocabRecord): Promise<void> {
    if (this.bridge === null) await this.list();
    if (!this.bridge) return this.fallback.append(record);
    const res = await fetch("/__glossa/vocab", { method: "POST", headers: headers({ "content-type": "application/json" }), body: JSON.stringify(record) });
    if (!res.ok) throw new Error(`写生词本失败（HTTP ${res.status}）`);
  }
}

export const vocabStore = new HttpVocabStore();
