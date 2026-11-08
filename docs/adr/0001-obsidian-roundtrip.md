# 0001 Obsidian 对 x-reader 字段的 round-trip

- 日期：2026-11-08
- 状态：自动部分已通过；真实 Obsidian 实测推迟到 v0.1 最后（2026-11-08 jiale 决定暂不关心）

## 背景

`main.canvas` 用 JSON Canvas 1.0，扩展信息写在节点的 `x-reader` 字段。规范不要求第三方写回时保留未知字段。

## 决定

1. 节点元数据双写进 `.canvas/nodes/<id>.md` 的 front matter；没有正文的节点也写最小文件。
2. 加载时若 `main.canvas` 的节点缺 `x-reader`，从 `.md` 补回（`loadCanvas().repaired` 列出补了哪些）。
3. 连线丢了 `x-reader.role` 时，用 `toEnd` 推断：有箭头 = derived，无箭头 = context。reference 会退化成 context，可接受。
4. 我们自己读写时保留所有未知字段（文档级、节点级、连线级）。

## 验证

- `packages/core/test/obsidian-roundtrip.test.ts`：模拟最坏情况（只写回规范字段 + 挪动卡片），断言 x-reader 全部重建、新位置保留。
- 真实 Obsidian：`pnpm obsidian:fixture` → Obsidian 中拖动保存 → `pnpm obsidian:check`。结果填在下面。

## 发现

- Obsidian 不显示以点开头的文件夹，书文件夹里的 `.canvas/main.canvas` 默认在 Obsidian 里看不见。要在 Obsidian 里看画布，需要导出或软链接到非点目录。是否提供「导出到 Obsidian」留到 v0.1 试读后决定。

## 实测结果

（待填：Obsidian 版本、是否保留 x-reader）
