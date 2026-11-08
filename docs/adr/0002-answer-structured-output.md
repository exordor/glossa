# 0002 回答结构：JSON schema 输出，文字解析做退路

- 日期：2026-11-08
- 状态：采用（PR #8）。jiale 2026-11-08 选定按设计文档用 JSON schema 输出。

## 背景

设计文档 v2「AI 上下文与结构化输出」：所有动作通过 tool use / JSON schema 输出，不解析自由文本。
v0.1 默认模型是 Vercel AI Gateway 上的 DeepSeek；DeepSeek 官方 API 只有 `json_object` 模式，不支持严格 schema。

## 决定

1. `@reader/core` 的 `answerSchema(depth)` 按回答深度生成 schema：`summary` 在前，`points` 或 `steps`，`citations: [{quote}]`。
   为兼容严格模式，字段全部 required、`additionalProperties: false`，不用 `maxLength` / `maxItems`（长度预算写在 description 和提示词里）。
2. `LlmRequest.output` 带上 schema；`@reader/llm` 交给 AI SDK `Output.object`，由 provider 决定发严格 schema 还是 JSON 模式（openai-compatible 默认退成 `json_object`）。
3. schema 同时写进系统提示词（`actionInstructions`），只支持 JSON 模式的模型也能按字段输出。
4. 流式：客户端用 `parsePartialJson` 把累积的文本补全成半截对象，发 `{type: "object", final: false}` 分块；结束时完整合法的 JSON 发 `final: true`。卡片先显示结论，要点陆续出现。
5. 显示管线只有一条：对象经 `answerFromObject` 规整、`answerToMarkdown` 转成短 Markdown，存进节点 text / `nodes/<id>.md` 正文，卡片和就地卡照旧渲染。
6. 退路：模型没给出合法 JSON（没有 final 块）时，用 `parseAnswer` 按文字解析，不让回答丢掉。
7. 引用校验：`citations` 字段 + 正文里「」括起的原话，逐条到章节原文核对，结果写进节点元数据 `citations`。

## 后续

- 设计文档里的 `[^e1]` 摘录 id 引用，等第 6 步上下文组装给每段摘录编号后再加（届时 citations 带 excerptId，只到对应摘录里核对）。
- 原始 JSON 和 citationErrors 记进 runs（第 7 步）。
- 真实 DeepSeek（网关与官方 API）各跑一次，确认 JSON 模式下的输出质量。
