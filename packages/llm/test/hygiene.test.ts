/** 仓库卫生：密钥永远不进仓库（设计 §4）。扫描已跟踪和未忽略的新文件。 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });

// 变量名后面紧跟像密钥的值（8 位以上字母数字）才算；模板里的空值、「…」占位不算。
const KEY_LINE = /^\s*(?:export\s+)?(AI_GATEWAY_API_KEY|DEEPSEEK_API_KEY|OPENAI_COMPATIBLE_API_KEY|OPENAI_API_KEY)\s*=\s*["']?[A-Za-z0-9_\-]{8,}/m;
// 网关密钥前缀 vck_（未核实）、DeepSeek / OpenAI 的 sk- 前缀。
const KEY_SHAPE = /\b(vck_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{32,})\b/;

describe("仓库里没有密钥", () => {
  it(".gitignore 忽略 .env.local / .env，但保留 .env.example", () => {
    // check-ignore 不忽略时退出码为 1（execFileSync 抛错）。
    expect(() => git("check-ignore", "-q", ".env.local")).not.toThrow();
    expect(() => git("check-ignore", "-q", ".env")).not.toThrow();
    expect(() => git("check-ignore", "-q", ".env.example")).toThrow();
  });

  it(".env.example 的密钥都是空值", () => {
    const text = readFileSync(join(root, ".env.example"), "utf8");
    expect(text).toMatch(/^AI_GATEWAY_API_KEY=$/m);
    expect(text).toMatch(/^DEEPSEEK_API_KEY=$/m);
  });

  it("已跟踪和待提交的文本文件里没有密钥", () => {
    const files = git("ls-files", "--cached", "--others", "--exclude-standard", "-z").split("\0").filter(Boolean);
    const hits: string[] = [];
    for (const f of files) {
      if (/\.(png|jpe?g|gif|webp|pdf|woff2?|ico)$/i.test(f) || f === "pnpm-lock.yaml") continue;
      let text: string;
      try {
        text = readFileSync(join(root, f), "utf8");
      } catch {
        continue; // 已删除但还在索引里
      }
      if (KEY_LINE.test(text) || KEY_SHAPE.test(text)) hits.push(f);
    }
    expect(hits).toEqual([]);
  });
});
