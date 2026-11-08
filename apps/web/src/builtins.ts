import { parseActionTemplate, type ActionTemplate, type Registry } from "@reader/core";

/**
 * 内置动作 = 仓库 templates/actions/*.md（文件即插件），打包时以文本形式内联。
 * 和第三方插件一样走 registry.register("action")；菜单顺序由 ORDER 决定，没列出的排在后面。
 */
const FILES = import.meta.glob("../../../templates/actions/*.md", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const ORDER = ["define", "parse-sentence", "explain", "ask", "note"];

export function builtinActionTemplates(): ActionTemplate[] {
  const list = Object.entries(FILES).map(([path, text]) => parseActionTemplate(text, path.replace(/^.*\/templates\//, "templates/")));
  const rank = (id: string) => (ORDER.includes(id) ? ORDER.indexOf(id) : ORDER.length);
  return list.sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id));
}

export function registerBuiltinActions(registry: Registry) {
  return builtinActionTemplates().map((a) => registry.register("action", a));
}
