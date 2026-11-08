/** @reader/core/node：只在 Node 里可用的实现（依赖 node:fs）。浏览器不要引入。 */
export { NodeVault } from "./vault-node.js";
export { NodeSettingsStore, readerHome } from "./settings-node.js";
