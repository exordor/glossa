import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts"],
    // LLM 调用在测试里全部走录制回放（fixtures/recordings/，按 promptHash），测试不花钱。
    env: { GLOSSA_LLM_RECORDINGS: "replay" },
    // 网络守卫：除本机回环地址外，测试里的 fetch 一律抛错。
    setupFiles: ["./vitest.setup.ts"],
  },
});
