/**
 * 生成 tokens.css：
 *   @layer locked, base, theme, snippets;
 *   locked：锁定 token 带 !important（越靠前的层，!important 优先级越高，后面的主题改不动）。
 *   base：其余 token，浅色为默认，暗色跟随系统或 data-theme="dark"。
 */
import { tierOf, cssVar } from "./tiers.js";
import { defaultTokens } from "./tokens.js";

function decls(map: Record<string, string>, filter: (k: string) => boolean, important = false): string {
  return Object.entries(map)
    .filter(([k]) => filter(k))
    .map(([k, v]) => `    ${cssVar(k)}: ${v}${important ? " !important" : ""};`)
    .join("\n");
}

export function buildTokensCss(): string {
  const light = defaultTokens("light");
  const dark = defaultTokens("dark");
  const locked = (k: string) => tierOf(k) === "locked";
  const notLocked = (k: string) => !locked(k);
  // 锁定 token 不分模式；edge-active 例外：等于各模式的 ai。
  const lockedStatic = (k: string) => locked(k) && k !== "edge-active";
  const darkDiff = (k: string) => notLocked(k) && dark[k] !== light[k];

  return `/* 由 packages/theme/scripts/build-css.ts 从 tokens.json 生成，不要手改。 */
@layer locked, base, theme, snippets;

@layer locked {
  :root {
${decls(light, lockedStatic, true)}
    --rd-edge-active: var(--rd-ai) !important;
  }
}

@layer base {
  :root {
    color-scheme: light dark;
${decls(light, notLocked)}
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
${decls(dark, darkDiff).replace(/^ {4}/gm, "      ")}
    }
  }
  :root[data-theme="dark"] {
${decls(dark, darkDiff)}
  }
}
`;
}
