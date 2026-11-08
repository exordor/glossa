import { describe, expect, it } from "vitest";
import { auditContrast, buildTokensCss, defaultTokens, tierOf, validateTheme } from "../src/index.js";

/** 设计系统 tokens.json 的已知对比度问题，已反馈给设计系统。 */
const KNOWN_DEFAULT_ISSUES: string[] = ["light: border-strong 在 canvas-ground 上 2.89:1 < 3:1"];

describe("--rd-* 变量", () => {
  const css = buildTokensCss();

  it("每个 token 都生成了 --rd- 变量", () => {
    for (const k of Object.keys(defaultTokens("light"))) expect(css).toContain(`--rd-${k}:`);
  });

  it("锁定 token 在 locked 层且带 !important", () => {
    const lockedBlock = css.slice(css.indexOf("@layer locked {"), css.indexOf("@layer base {"));
    expect(lockedBlock).toContain("--rd-stroke-edge:");
    expect(lockedBlock).toMatch(/--rd-dash-reference: [^;]+ !important;/);
    expect(lockedBlock).toContain("--rd-edge-active: var(--rd-ai) !important;");
    expect(lockedBlock).not.toContain("--rd-surface:");
  });

  it("阅读器排版是开放层，不在 locked 里", () => {
    expect(tierOf("reader-font-size")).toBe("open");
    expect(tierOf("size-card-answer")).toBe("locked");
  });

  it("暗色同时支持跟随系统和 data-theme=dark", () => {
    expect(css).toContain("@media (prefers-color-scheme: dark)");
    expect(css).toContain(':root:not([data-theme="light"])');
    expect(css).toContain(':root[data-theme="dark"]');
  });
});

describe("主题校验", () => {
  const defaults = defaultTokens("light");

  it("不覆盖任何 token 时没有问题，edge-active 等于 ai", () => {
    for (const mode of ["light", "dark"] as const) {
      const d = defaultTokens(mode);
      const r = validateTheme(d, {});
      expect(r.issues).toEqual([]);
      expect(r.tokens["edge-active"]).toBe(d.ai);
    }
  });

  it("审计默认主题自身的对比度（已知问题记在这里，修了设计系统就删掉）", () => {
    const found = (["light", "dark"] as const).flatMap((mode) =>
      auditContrast(defaultTokens(mode)).map((i) => `${mode}: ${i.detail}`),
    );
    expect(found).toEqual(KNOWN_DEFAULT_ISSUES);
  });

  it("锁定 token 被忽略，对比度不够的受约束 token 退回默认值，其余生效", () => {
    const { tokens, issues } = validateTheme(defaults, {
      "stroke-edge": "9px",
      ink: "#eeeeee",
      surface: "#fffaf0",
    });
    expect(tokens["stroke-edge"]).toBe(defaults["stroke-edge"]);
    expect(tokens.ink).toBe(defaults.ink);
    expect(tokens.surface).toBe("#fffaf0");
    expect(issues.map((i) => [i.token, i.reason])).toEqual([
      ["stroke-edge", "locked"],
      ["ink", "contrast"],
    ]);
  });
});
