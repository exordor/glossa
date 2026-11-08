/**
 * 重新录制 fixtures/recordings（设计「录制回放」：record 模式，手动 `pnpm llm:record`）。
 * 真实联网、花钱：密钥只从环境变量或仓库根目录 .env.local 读（AI_GATEWAY_API_KEY / DEEPSEEK_API_KEY / OPENAI_COMPATIBLE_API_KEY），不打印。
 *
 *   pnpm llm:record                      录一键测试（fast），用默认服务商 vercel-gateway
 *   pnpm llm:record -- deepseek smart    指定服务商和别名
 *
 * 提示词、模型 id 等任何一项变了，promptHash 就变，旧文件不会被覆盖，需手动删除。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type ModelAlias, MemorySettingsStore, createAppLlm, defaultSettings } from "@reader/core";
import { directTransport, registerBuiltinLlmProviders } from "../packages/llm/src/index.js";
import { REPO_RECORDINGS_DIR, useRepoRecordings } from "../packages/llm/src/node.js";

const ENV_VARS: Record<string, string> = {
  "vercel-gateway": "AI_GATEWAY_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  "openai-compatible": "OPENAI_COMPATIBLE_API_KEY",
};

/** 只认这几个变量名，其余行忽略。 */
function envLocal(): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    const text = readFileSync(join(fileURLToPath(new URL("..", import.meta.url)), ".env.local"), "utf8");
    for (const line of text.split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?([A-Z_]+)\s*=\s*["']?([^"'\s]*)["']?\s*$/.exec(line);
      if (m && Object.values(ENV_VARS).includes(m[1]!)) out[m[1]!] = m[2]!;
    }
  } catch {
    // 没有 .env.local
  }
  return out;
}

async function main() {
  const [providerId = "vercel-gateway", alias = "fast"] = process.argv.slice(2).filter((a) => a !== "--");
  const fileEnv = envLocal();
  const store = useRepoRecordings();
  const s = defaultSettings();
  s.llm.activeProvider = providerId;
  const app = createAppLlm({ settings: new MemorySettingsStore(s) });
  registerBuiltinLlmProviders(app.registry, {
    transport: directTransport({ apiKey: (id) => process.env[ENV_VARS[id] ?? ""] || fileEnv[ENV_VARS[id] ?? ""] || undefined }),
    recordings: { mode: "record", store },
  });
  let failed = false;
  for await (const c of app.llm.test(alias as ModelAlias)) {
    if (c.type === "text") process.stdout.write(c.delta);
    if (c.type === "error") {
      failed = true;
      console.error(`\n失败：${c.error.code} ${c.error.message}`);
    }
  }
  console.log(failed ? "" : `\n已写入 ${REPO_RECORDINGS_DIR}`);
  process.exitCode = failed ? 1 : 0;
}

void main();
