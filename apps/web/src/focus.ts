/** 聚焦模式的状态：tldraw 的 atom，卡片和连线组件读它，变了自动重绘。null 表示没有聚焦。 */
import { atom } from "tldraw";

export const focusAtom = atom<ReadonlySet<string> | null>("glossa.focus", null);
