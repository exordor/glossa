/** Reader.save() 和并发的 updateNode：保存进行中设的正文不能丢（canvas / nodes/*.md 双写，硬规则 5）。 */
import { describe, expect, it } from "vitest";
import { MemoryVault, NODES_DIR, Reader, parseNodeFile } from "../src/index.js";

/** 写 nodes/*.md 时先停住，等测试放行。 */
class GatedVault extends MemoryVault {
  gate: Promise<void> | null = null;
  reached: (() => void) | null = null;
  override async writeText(path: string, text: string) {
    if (this.gate && path.startsWith(`${NODES_DIR}/`)) {
      this.reached?.();
      await this.gate;
    }
    await super.writeText(path, text);
  }
}

describe("Reader.save", () => {
  it("保存进行中 updateNode 设的 body 留给下一次 save，不被清掉", async () => {
    const vault = new GatedVault();
    const reader = new Reader(vault);
    await reader.open();
    const n = await reader.createNode({ type: "answer", x: 0, y: 0, width: 100, height: 100, status: "running", createdBy: "ai" });
    await reader.save();

    let release!: () => void;
    vault.gate = new Promise<void>((ok) => (release = ok));
    const reached = new Promise<void>((ok) => (vault.reached = ok));
    const first = reader.save();
    await reached; // 第一次保存已经停在写 nodes/<id>.md 上（已经取过这个节点的 body）
    await reader.updateNode(n.id, { status: "done", body: "完整回答" });
    release();
    await first;
    vault.gate = null;
    await reader.save();
    expect(parseNodeFile(vault.files.get(`${NODES_DIR}/${n.id}.md`)!).body).toContain("完整回答");
  });

  it("保存失败时待写正文保留，重试能写出", async () => {
    const vault = new MemoryVault();
    const reader = new Reader(vault);
    await reader.open();
    const n = await reader.createNode({ type: "answer", x: 0, y: 0, width: 100, height: 100, body: "回答" });
    const orig = vault.writeText.bind(vault);
    vault.writeText = async () => {
      throw new Error("磁盘满");
    };
    await expect(reader.save()).rejects.toThrow("磁盘满");
    vault.writeText = orig;
    await reader.save();
    expect(parseNodeFile(vault.files.get(`${NODES_DIR}/${n.id}.md`)!).body).toContain("回答");
  });
});
