# 0002 回答结构：从 Markdown 文字解析，而不是 JSON schema 输出

- 日期：2026-11-08
- 状态：v0.1 采用（PR #8）；待 jiale 确认

## 背景

设计文档 v2「AI 上下文与结构化输出」写的是：所有动作通过 tool use / JSON schema 输出，不解析自由文本。
v0.1 的默认模型是 Vercel AI Gateway 上的 DeepSeek。它对 JSON schema 严格输出的支持没有核实过，官方 API 只有 json_object 模式。

## 决定

v0.1 先让模型写约定格式的短 Markdown（第一行结论，后面「- 」要点或「1. 」步骤，原话用「」括起），由 `@reader/core` 的 `parseAnswer` 解析成 `{summary, points | steps, citations}`。

- 流式时第一行就是结论，满足「summary → points / steps」的顺序，不用等 JSON 闭合。
- 任何 provider 都能用，换模型不用改动作。
- 录制回放夹具存的仍是可读文字。
- 引用校验照做：`verifyCitations` 把「」里的原话逐条到原文核对，没找到的标出来。

## 代价与后续

- 格式靠提示词约束，模型偶尔会偏离（加小标题、不分行）。解析做了容错（去掉「结论：」标签等），回答卡在解析不出列表时照原文显示。
- 设计文档里的 `[^e1]` 摘录 id 引用，等第 6 步上下文组装给每段摘录编号后再加。
- `LlmRequest.output`（JSON schema）接口保留。需要严格结构的动作（如风格拆解拆成多卡、反问生成节点）出现时，在 `@reader/llm` 接上 AI SDK 的结构化输出，并先实测 DeepSeek。
