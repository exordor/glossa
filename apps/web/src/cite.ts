/** 引用校验的说明文字（纯函数，便于测试）。 */
import type { Citation } from "@reader/core";

/** 全部找到 / 有几处没找到。没有引用时返回 null（不显示）。text 给就地卡，short 给画布卡底部一行。 */
export function citeSummary(citations: readonly Citation[]): { text: string; short: string; warn: boolean } | null {
  if (!citations.length) return null;
  const n = citations.length;
  const missing = citations.filter((c) => !c.verified).length;
  if (!missing) return { text: `引用原文 ${n} 处，都在原文里找到了`, short: `引用 ${n} 处，均已核对原文`, warn: false };
  return {
    text: `引用原文 ${n} 处，${missing} 处在原文里没找到（已加虚线），可能是模型改写的`,
    short: `${missing} 处引用在原文里没找到`,
    warn: true,
  };
}
