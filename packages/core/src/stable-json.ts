/**
 * 键按固定顺序序列化，diff 干净（设计文档 AX「文件即 API」）。
 * 已知键按给定顺序在前，其余键按字母序在后；嵌套对象同样按字母序。
 */
export function sortKeys(value: unknown, order: readonly string[] = []): unknown {
  if (Array.isArray(value)) return value.map((v) => sortKeys(v));
  if (value === null || typeof value !== "object") return value;
  const obj = value as Record<string, unknown>;
  const known = order.filter((k) => k in obj);
  const rest = Object.keys(obj)
    .filter((k) => !order.includes(k))
    .sort();
  const out: Record<string, unknown> = {};
  for (const k of [...known, ...rest]) {
    if (obj[k] !== undefined) out[k] = sortKeys(obj[k]);
  }
  return out;
}

export function stableStringify(value: unknown, order: readonly string[] = []): string {
  return JSON.stringify(sortKeys(value, order), null, "\t") + "\n";
}
