/**
 * glossa-dev-bridge 的 Vite 插件外壳（apply: "serve"）。
 * vite.config.ts 由 Node 直接加载，不能静态引入工作区里的 TS 源码（@reader/core、@reader/llm），
 * 所以实现（./glossa-dev-bridge.ts）在 dev server 起来后经 ssrLoadModule 加载；vite build 完全不碰它。
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import type { BridgeOptions, createBridgeMiddleware } from "./glossa-dev-bridge";

const IMPL = fileURLToPath(new URL("./glossa-dev-bridge.ts", import.meta.url));

export function glossaDevBridge(opts: Partial<BridgeOptions> = {}): Plugin {
  return {
    name: "glossa-dev-bridge",
    apply: "serve",
    async configureServer(server) {
      const mod = (await server.ssrLoadModule(IMPL)) as { createBridgeMiddleware: typeof createBridgeMiddleware };
      // .env.local 在仓库根目录（apps/web 往上两级）。
      const envDir = opts.envDir ?? resolve(server.config.root, "../..");
      server.middlewares.use(mod.createBridgeMiddleware({ ...opts, envDir, mode: opts.mode ?? server.config.mode }));
    },
  };
}
