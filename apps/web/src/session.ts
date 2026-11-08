/**
 * 一本书 = 一个 Reader（@reader/core）。界面拿到的 reader 和 CLI / MCP / 插件是同一个对象，
 * 内置功能从第一天起都走 registry.register()。
 */
import { Reader, type Book, type ImportResult, type Vault } from "@reader/core";
import { registerMarkdownSource } from "@reader/source-markdown";
import { registerBuiltinActions } from "./builtins";
import { registerLlmProviders, settingsStore } from "./llm";

export interface BookSession {
  reader: Reader;
  book: Book;
  name: string;
  /** false = 示例书，改动只在内存里。 */
  persistent: boolean;
  importResult: ImportResult;
}

export async function openBook(vault: Vault, name: string, persistent: boolean): Promise<BookSession> {
  // 全局设置（~/.reader/settings.json）经 dev bridge 读写；和应用级 LLM 共用同一个存取对象。
  const reader = new Reader(vault, { settings: settingsStore });
  registerMarkdownSource(reader.registry);
  registerBuiltinActions(reader.registry);
  registerLlmProviders(reader.registry);
  reader.registry.register("panel", { id: "source", title: "原文", component: "SourcePanel" });
  reader.registry.register("panel", { id: "answer", title: "回答", component: "AnswerPanel" });
  reader.registry.register("panel", { id: "context", title: "本次上下文", component: "ContextPanel" });
  await reader.open();
  const importResult = await reader.importBook(name);
  return { reader, book: importResult.book, name, persistent, importResult };
}
