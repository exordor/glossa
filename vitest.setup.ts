/**
 * 测试网络守卫：漏掉录制回放时也打不到真实服务商。只放行 localhost / 127.0.0.1 / ::1（bridge 测试用本机假上游）。
 */
const realFetch = globalThis.fetch;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    // 相对地址：不是真实网络请求，交给原实现报错。
  }
  if (host && !LOOPBACK.has(host)) throw new TypeError(`测试禁止联网：${url}`);
  return realFetch(input, init);
}) as typeof fetch;

// 录制回放：没有显式传 store 的客户端（如直接用 registerBuiltinLlmProviders）也回放仓库里的 fixtures/recordings。
import { useRepoRecordings } from "./packages/llm/src/node.js";
useRepoRecordings();
