import { monotonicFactory } from "ulid";

const next = monotonicFactory();

/** 所有 id 用 ULID（按时间排序，文件 diff 稳定）。 */
export function newId(now: number = Date.now()): string {
  return next(now);
}
