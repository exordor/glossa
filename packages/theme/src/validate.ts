/**
 * 主题校验（Theming.md「校验规则」）：锁定 token 忽略；受约束 token 不过对比度就单独退回默认值。
 * v0.1 只用于内置主题自检；v0.3 主题加载器复用同一函数。
 */
import { contrastRatio, hue } from "./contrast.js";
import { tierOf } from "./tiers.js";

export type Mode = "light" | "dark";
export type TokenMap = Record<string, string>;

export interface ThemeIssue {
  token: string;
  reason: "locked" | "contrast" | "hue";
  detail: string;
}

const TEXT_TOKENS = ["ink", "ink-muted", "ai-ink", "user-ink", "danger-ink", "broken"];
const MARK_TOKENS = ["source", "ai", "user", "danger", "stale", "edge", "border-strong", "focus-ring"];
const MARK_GROUNDS = ["surface", "surface-paper", "canvas-ground"];

/** 文字 token 的背景：ai-ink 在 ai-soft 上，其余在 surface 上。 */
const TEXT_GROUND: Record<string, string> = {
  "ai-ink": "ai-soft",
  "user-ink": "user-soft",
  "danger-ink": "danger-soft",
};

export function validateTheme(defaults: TokenMap, overrides: TokenMap): { tokens: TokenMap; issues: ThemeIssue[] } {
  const issues: ThemeIssue[] = [];
  const merged: TokenMap = { ...defaults };
  for (const [k, v] of Object.entries(overrides)) {
    if (tierOf(k) === "locked") issues.push({ token: k, reason: "locked", detail: "锁定的变量，已忽略" });
    else merged[k] = v;
  }

  const revert = (token: string, reason: ThemeIssue["reason"], detail: string) => {
    if (!(token in overrides)) return; // 默认值本身不在主题的责任范围
    merged[token] = defaults[token]!;
    issues.push({ token, reason, detail });
  };

  for (const t of TEXT_TOKENS) {
    const ground = TEXT_GROUND[t] ?? "surface";
    const r = contrastRatio(merged[t] ?? "", merged[ground] ?? "");
    if (r !== null && r < 4.5) revert(t, "contrast", `${t} 在 ${ground} 上 ${r.toFixed(2)}:1 < 4.5:1`);
  }
  for (const t of MARK_TOKENS) {
    for (const g of MARK_GROUNDS) {
      const r = contrastRatio(merged[t] ?? "", merged[g] ?? "");
      if (r !== null && r < 3) {
        revert(t, "contrast", `${t} 在 ${g} 上 ${r.toFixed(2)}:1 < 3:1`);
        break;
      }
    }
  }
  const onAccent = contrastRatio(merged["on-accent"] ?? "", merged["ai"] ?? "");
  if (onAccent !== null && onAccent < 4.5) revert("on-accent", "contrast", `on-accent 在 ai 上 ${onAccent.toFixed(2)}:1 < 4.5:1`);

  const ha = hue(merged["ai"] ?? "");
  const hu = hue(merged["user"] ?? "");
  if (ha !== null && hu !== null) {
    const diff = Math.min(Math.abs(ha - hu), 360 - Math.abs(ha - hu));
    if (diff < 60) {
      revert("user", "hue", `ai 与 user 色相差 ${diff.toFixed(0)}° < 60°`);
      revert("ai", "hue", `ai 与 user 色相差 ${diff.toFixed(0)}° < 60°`);
    }
  }
  // edge-active 永远等于 ai
  merged["edge-active"] = merged["ai"]!;
  return { tokens: merged, issues };
}

/** 不考虑覆盖，直接列出一组 token 的全部对比度问题。用于审计默认主题。 */
export function auditContrast(tokens: TokenMap): ThemeIssue[] {
  const all: TokenMap = {};
  for (const k of Object.keys(tokens)) if (tierOf(k) !== "locked") all[k] = tokens[k]!;
  // 把每个受约束 token 当成「被覆盖」跑一遍校验，收集问题。
  return validateTheme(tokens, all).issues.filter((i) => i.reason !== "locked");
}
