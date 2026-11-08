import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { glossaDevBridge } from "./dev/plugin";

export default defineConfig({
  // glossaDevBridge 只在 dev server 里：LLM 转发、密钥、~/.reader/settings.json。生产构建没有它（AI 功能提示用桌面版或 pnpm dev）。
  plugins: [react(), glossaDevBridge()],
  server: { fs: { allow: ["../.."] } },
});
