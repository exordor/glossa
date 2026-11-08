# Glossa

本地优先的无限画布 AI 阅读器。代码全部由 code agent 编写；改动前先读设计文档。

## 先读

- 设计文档 v2（工作版）：https://claude.ai/artifact/WaGAnpgS5SyYvgFqBSeEpT（导出到 `docs/design.md` 后以仓库为准）
- 设计系统（token、图标、组件）：https://claude.ai/artifact/AQRrzB5kcuWptyNXmXa2a7 。`packages/theme/tokens.json` 是它的副本。
- v0.1 计划：`docs/plan-v0.1.md`；决策记录：`docs/adr/`

## 结构

| 路径 | 作用 |
| --- | --- |
| `packages/core` (`@reader/core`) | 数据模型、JSON Canvas 读写、nodes/*.md 双写、注册表、事件总线。界面、CLI、MCP、插件**只**通过它访问数据。 |
| `packages/theme` (`@reader/theme`) | tokens.json → `--rd-*` CSS 变量（cascade layers：locked, base, theme, snippets）；主题分层与对比度校验。 |
| `packages/source-markdown` | 第一个 SourceAdapter：Markdown 锚点三层定位。 |
| `packages/llm` (`@reader/llm`) | LLM 网关实现：三个内置 provider（vercel-gateway、deepseek、openai-compatible）、能力检查、录制回放。只有它依赖 AI SDK；界面只调 `reader.llm`。 |
| `apps/web` | Vite + React + tldraw 界面。 |
| `schemas/` | 所有落盘格式的 JSON Schema 和事件名（`events.json`）。 |
| `fixtures/` | 测试夹具：`sample-book/`（3 章，含图片、公式、代码块、表格）。 |

## 硬规则（v1 预留项，现在便宜、以后贵）

1. 组件里不写颜色、字号、间距、圆角的字面值，全部用 `var(--rd-*)`。新 token 先进设计系统。
2. 内置动作、来源适配器、面板一律 `registry.register()` 注册，不走后门。
3. 事件名改动要同时改 `schemas/events.json`（有测试校验两边一致）。
4. 所有落盘文件带 `schemaVersion`，键按固定顺序序列化（`stableStringify`），diff 干净。
5. `main.canvas` 的 `x-reader` 必须同时写进 `nodes/<id>.md` 的 front matter；读入时保留所有未知字段。
6. 核心 API 异步、参数和返回值可序列化，不传 DOM 对象。

## 命令

```sh
pnpm install
pnpm test          # vitest，全部单元测试（含 Obsidian 字段保留测试）
pnpm typecheck
pnpm tokens        # 重新生成 packages/theme/dist/tokens.css
pnpm dev           # 启动界面（先跑 pnpm tokens）
pnpm obsidian:fixture && pnpm obsidian:check   # 真实 Obsidian round-trip 实测，见脚本注释
```

LLM 调用在测试里全部走录制回放（`fixtures/recordings/`，按 promptHash），测试不花钱。
