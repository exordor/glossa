/**
 * 主题 token 三层（设计系统 Theming.md）：开放 / 受约束 / 锁定。
 * 锁定层承载语义通道（线型、标记形状）和可访问性（命中区），主题改不动。
 */
export type Tier = "open" | "constrained" | "locked";

const CONSTRAINED = new Set([
  "ink", "ink-muted",
  "source", "ai", "ai-ink", "ai-soft", "ai-soft-2", "user", "user-ink", "user-soft", "user-soft-2",
  "danger", "danger-ink", "danger-soft", "stale", "stale-soft", "broken",
  "edge", "edge-muted", "border-strong", "focus-ring", "on-accent",
]);

/** reader-* 虽然在 size 组里，但属于开放层（阅读器排版）。 */
const OPEN_EXCEPTIONS = new Set(["reader-font-size", "reader-line-height", "reader-measure"]);

export function tierOf(token: string): Tier {
  if (OPEN_EXCEPTIONS.has(token)) return "open";
  if (token === "edge-active") return "locked"; // 永远等于 ai
  if (/^(stroke|dash|size|z|opacity)-/.test(token)) return "locked";
  if (CONSTRAINED.has(token)) return "constrained";
  return "open";
}

/** CSS 变量名：所有 token 统一加 --rd- 前缀。 */
export const cssVar = (token: string) => `--rd-${token}`;
