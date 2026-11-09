# v0.1 实现计划

v0.1 只验证一件事：在画布上读一章书、选段提问，比在编辑器旁边开一个聊天窗口更好用。出口标准是设计文档「成功指标」表（追问率 ≥ 30%、跳回原文 ≥ 3 次 / 章、首字 < 3 s 中位数、锚点失效率 < 2%、愿意读下一本）。

## 技术栈

| 层 | 选型 | 备注 |
| --- | --- | --- |
| 仓库 | pnpm workspace monorepo，全 TypeScript | Node 22 |
| 核心 | `@reader/core`（独立包） | 界面、CLI、MCP、插件只通过它访问数据 |
| 画布 | tldraw SDK 5.x | 接受免费版水印（决策记录） |
| 界面 | React 19 + Vite 7 | 开发期纯 Web（Chromium + File System Access API），发布用 Tauri |
| Markdown | unified：remark-parse + remark-gfm + remark-math；渲染加 rehype + KaTeX + Shiki | 每个语法节点带源文件偏移，锚点靠它 |
| LLM | Vercel AI SDK provider registry，模型别名 fast / smart / vision / image | 开发期映射到低成本模型；OpenAI 兼容、Ollama |
| 索引 | SQLite FTS5（浏览器 wa-sqlite + OPFS） | 可删可重建 |
| 测试 | Vitest；界面用 Playwright 跑固定剧本；LLM 录制回放 | 测试不花钱 |
| 主题 | `--rd-*` CSS 变量，cascade layers `locked, base, theme, snippets` | 由设计系统 tokens.json 生成 |

## 已完成（本 PR：骨架）

- [x] monorepo、`@reader/core` 独立包：数据模型类型、ULID、稳定键序序列化
- [x] JSON Canvas 读写：保留未知字段，`x-reader` 双写进 `nodes/<id>.md`，丢字段时自动重建
- [x] 扩展点注册表（10 个扩展点）+ 事件总线，事件名与 `schemas/events.json` 有测试校验
- [x] `--rd-*` 变量：从设计系统 tokens.json 生成 tokens.css；主题三层 + 对比度校验
- [x] Markdown 适配器：锚点三层定位、粒度判定、extract 三层（选中 / 所在句 / 所在段），通过注册表注册
- [x] 批注包含树算法（平铺存储，按 start 升序 end 降序算父节点）
- [x] Obsidian 字段保留测试（自动模拟最坏情况）+ 真实 Obsidian 实测脚本
- [x] 界面空壳：三栏布局、tldraw 画布、阅读器选中文字 → 浮层按钮（来自注册表）→ 画布出卡
- [x] schemas：插件 manifest、主题、节点元数据、事件名；fixtures/sample-book（3 章，含图片、公式、代码块、表格）

## 接下来（按顺序，每项一个 PR）

1. ✅ **打开书文件夹**（PR #3）：File System Access API 的 Vault 实现；导入章节、生成 book.json、章节卡横向排开；恢复视口。
2. ✅ **阅读器正式渲染**（PR #2，Shiki 代码高亮暂缓）：rehype + KaTeX + Shiki，保留源偏移；DOM 选区 → 源偏移；跳回原文（滚动 + 闪烁高亮）。
3. **自定义卡片 shape**：六种节点按设计系统渲染（左色条、图标、状态徽章、agent 角标）；三种连线 role 的线型；问答卡合成视图与「展开」。
4. ✅ **LLM 网关**（PR #5，真实调用待本机验证）：AI SDK registry + 别名 + 能力表；设置页（provider、Key、一键测试）；首次启动引导。
5. ✅ **动作模板**（PR #6–#8）：`templates/actions/*.md` 加载为 action 扩展点；词义、拆句就地弹卡 +「钉到画布」；提问 / 解释生成问答卡；结构化输出 + 引用校验；流式 summary → points / steps。
6. ✅ **上下文组装**（PR #9）：7 项固定顺序 + 压缩优先级 + 预算；「本次上下文」面板。
7. ✅ **运行记录与统计**（PR #10）：`runs/*.jsonl`、`stats.jsonl`；录制回放夹具。
8. ✅ **注意力机制**（PR #11–#13）：跟随阅读、视口外新卡提示、语义缩放、聚焦模式；撤销重做（tldraw 历史栈 + 数据层删除恢复，见 ADR 0004）；Cmd+K 搜索（v0.1 内存匹配，FTS5 推后，见 ADR 0003）。
9. ✅ **批注多层显示**（PR #14–#15）：边沟色条、句级背景、短语下划线、叠层浮层（9a）；生词本收集（9b）。画布上按段落聚簇缩进、「包含」线、「作为…的子批注」、一段超过 5 张折叠，放到 9a 之后。
10. **锚点黄金测试**：对改标题、插段、改字三类修改测三层命中率，作为「锚点失效率 < 2%」的守门测试。

## 最后再做（暂不关心）

- 真实 Obsidian round-trip 实测：`pnpm obsidian:fixture` → 用 Obsidian 打开 `tmp/obsidian-roundtrip`，拖一张卡片 → `pnpm obsidian:check`，结果填进 `docs/adr/0001-obsidian-roundtrip.md`。自动测试已覆盖最坏情况（字段全丢也能从 `nodes/*.md` 重建），所以这一步不阻塞 v0.1。
- 「在 Obsidian 里查看画布」（`.canvas/` 是点目录，Obsidian 默认不显示）：是否提供导出，等 v0.1 试读后再说。
