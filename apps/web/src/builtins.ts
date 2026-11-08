import type { ActionTemplate, Registry } from "@reader/core";

/**
 * v0.1 内置动作。最终由 templates/actions/*.md 生成（文件即插件），这里先写死同样的字段。
 */
const BUILTIN_ACTIONS: ActionTemplate[] = [
  { id: "define", name: "词义", model: "fast", input: ["word"], depth: "brief", usesLLM: true, prompt: "" },
  { id: "ask", name: "提问", model: "smart", input: ["word", "sentence", "passage"], depth: "points", usesLLM: true, prompt: "" },
  { id: "explain", name: "解释", model: "smart", input: ["sentence", "passage"], depth: "points", usesLLM: true, prompt: "" },
  { id: "parse-sentence", name: "拆句", model: "fast", input: ["sentence"], depth: "steps", usesLLM: true, prompt: "" },
  { id: "note", name: "批注", model: "fast", input: ["word", "sentence", "passage"], depth: "brief", usesLLM: false, prompt: "" },
];

export function registerBuiltinActions(registry: Registry) {
  return BUILTIN_ACTIONS.map((a) => registry.register("action", a));
}
