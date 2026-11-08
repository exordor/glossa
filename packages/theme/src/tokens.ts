import tokens from "../tokens.json" with { type: "json" };
import type { Mode, TokenMap } from "./validate.js";

type Valued = { name: string; value: string | Record<Mode, string> };

/** 设计系统 tokens.json 里的全部 token，按模式展开（不分模式的 token 两边一样）。 */
export function defaultTokens(mode: Mode): TokenMap {
  const out: TokenMap = {};
  const groups: Valued[][] = [
    tokens.color.tokens as Valued[],
    tokens.spacing.tokens as Valued[],
    tokens.radius.tokens as Valued[],
    tokens.shadow.tokens as Valued[],
    tokens.size.tokens as Valued[],
    tokens.stroke.tokens as Valued[],
    tokens.opacity.tokens as Valued[],
    tokens.zIndex.tokens as Valued[],
  ];
  for (const group of groups) {
    for (const t of group) out[t.name] = typeof t.value === "string" ? t.value : t.value[mode];
  }
  const fam = tokens.type.families as Record<string, string>;
  for (const [k, v] of Object.entries(fam)) out[`font-${k}`] = v;
  for (const g of tokens.type.groups as Array<{ family: string; styles: Array<{ name: string; fontSize: string; lineHeight: string; fontWeight: number }> }>) {
    for (const s of g.styles) {
      // 组合字体变量：组件里写 font: var(--rd-type-card-title)
      out[`type-${s.name}`] = `${s.fontWeight} ${s.fontSize}/${s.lineHeight} var(--rd-font-${g.family})`;
      out[`text-${s.name}-size`] = s.fontSize;
      out[`text-${s.name}-line`] = s.lineHeight;
      out[`text-${s.name}-weight`] = String(s.fontWeight);
    }
  }
  return out;
}
