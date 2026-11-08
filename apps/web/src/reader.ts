/**
 * 界面拿到的 reader 和 CLI / MCP / 插件是同一个 @reader/core 对象。
 * 内置功能从第一天起都走 registry.register()。
 */
import { MemoryVault, Reader } from "@reader/core";
import { registerMarkdownSource } from "@reader/source-markdown";
import { registerBuiltinActions } from "./builtins";

export const reader = new Reader(new MemoryVault());
registerMarkdownSource(reader.registry);
registerBuiltinActions(reader.registry);
reader.registry.register("panel", { id: "source", title: "原文", component: "SourcePanel" });
reader.registry.register("panel", { id: "answer", title: "回答", component: "AnswerPanel" });
reader.registry.register("panel", { id: "context", title: "本次上下文", component: "ContextPanel" });
