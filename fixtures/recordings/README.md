# LLM 录制

测试里的 LLM 调用全部回放这里的文件（`GLOSSA_LLM_RECORDINGS=replay`，vitest 默认），按 promptHash 命名，格式见 `schemas/recording.schema.json`。

- `de88a4cf….json`：一键测试提示词（fast，`deepseek/deepseek-v4.1-flash-1017`）。**手写**的流，有密钥后用 `GLOSSA_LLM_RECORDINGS=record` 重新录制。
- 提示词、模型 id、maxOutputTokens、reasoning 等任何一项变了，hash 就变，需要重新录制。
