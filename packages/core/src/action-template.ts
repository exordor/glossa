/**
 * 动作模板：templates/actions/<id>.md（front matter = 字段，正文 = 提示词）。文件即插件。
 * 这里只做解析和校验，加载（读文件、注册）由调用方做：浏览器用打包进来的文本，CLI 读目录。
 */
import { parse } from "yaml";
import type { ActionTemplate, ModelAlias } from "./registry.js";
import type { ContextPart } from "./source.js";

const ALIASES: readonly ModelAlias[] = ["fast", "smart", "vision", "image"];
const INPUTS = ["word", "sentence", "passage", "chapter", "image"] as const;
const DEPTHS = ["brief", "points", "steps"] as const;

export class ActionTemplateError extends Error {
  constructor(file: string, message: string) {
    super(`${file}：${message}`);
    this.name = "ActionTemplateError";
  }
}

/** 解析一个模板文件。字段不合法时抛 ActionTemplateError（带文件名）。 */
export function parseActionTemplate(text: string, file = "action.md"): ActionTemplate {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) throw new ActionTemplateError(file, "缺少 front matter");
  let fm: Record<string, unknown>;
  try {
    fm = (parse(m[1] ?? "") ?? {}) as Record<string, unknown>;
  } catch (e) {
    throw new ActionTemplateError(file, `front matter 不是合法 YAML（${(e as Error).message}）`);
  }
  const fail = (msg: string): never => {
    throw new ActionTemplateError(file, msg);
  };
  if (fm.schemaVersion !== 1) fail("schemaVersion 必须是 1");
  const id = fm.id;
  if (typeof id !== "string" || !/^[a-z][a-z0-9-]*$/.test(id)) fail("id 必须是小写字母、数字和连字符");
  if (typeof fm.name !== "string" || !fm.name.trim()) fail("缺少 name");
  if (!ALIASES.includes(fm.model as ModelAlias)) fail(`model 必须是 ${ALIASES.join(" / ")}`);
  const input = fm.input;
  if (!Array.isArray(input) || input.length === 0 || !input.every((x) => (INPUTS as readonly unknown[]).includes(x)))
    fail(`input 必须是非空数组，取值 ${INPUTS.join(" / ")}`);
  if (!(DEPTHS as readonly unknown[]).includes(fm.depth)) fail(`depth 必须是 ${DEPTHS.join(" / ")}`);
  if (typeof fm.usesLLM !== "boolean") fail("usesLLM 必须是 true 或 false");
  const prompt = (m[2] ?? "").trim();
  if (fm.usesLLM && !prompt) fail("调用 AI 的动作必须写提示词正文");
  const t: ActionTemplate = {
    id: id as string,
    name: (fm.name as string).trim(),
    model: fm.model as ModelAlias,
    input: input as ActionTemplate["input"],
    depth: fm.depth as ActionTemplate["depth"],
    usesLLM: fm.usesLLM as boolean,
    prompt,
  };
  if (fm.placement !== undefined && fm.placement !== "canvas" && fm.placement !== "inline") fail("placement 必须是 canvas 或 inline");
  if (fm.placement === "inline") t.placement = "inline";
  if (typeof fm.output === "string") t.output = fm.output;
  return t;
}

/**
 * 把选区的三层内容组装成发给模型的用户消息。第 6 步「上下文组装」会替换成 7 项固定顺序 + 预算，
 * 这里先给出最小可用的版本：出处、选中、所在句、所在段（与选中相同的层省略）。
 */
export function actionUserMessage(t: ActionTemplate, part: Extract<ContextPart, { kind: "text" }>): string {
  const lines: string[] = [];
  if (part.headingPath.length) lines.push(`【出处】${part.headingPath.join(" › ")}`);
  lines.push(`【选中】${part.selected}`);
  const wantsSentence = t.input.some((i) => i === "word" || i === "sentence");
  const wantsPassage = t.input.some((i) => i === "passage" || i === "sentence" || i === "word");
  if (wantsSentence && part.sentence && part.sentence !== part.selected) lines.push(`【所在句】${part.sentence}`);
  if (wantsPassage && part.paragraph && part.paragraph !== part.sentence && part.paragraph !== part.selected)
    lines.push(`【所在段】${part.paragraph}`);
  return lines.join("\n\n");
}
