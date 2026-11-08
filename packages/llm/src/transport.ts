/**
 * 传输层：provider 只认上游真实地址（如 https://api.deepseek.com/chat/completions），
 * 由注入的 transport 决定请求怎么出去。
 *
 * 浏览器（开发期）走 dev bridge，约定：
 *   上游 `${upstreamBase}${rest}`  →  同源 `${origin}/__llm/<providerId>${rest}`，并带请求头 `x-glossa-bridge: 1`。
 *   bridge 在服务端按 providerId 找回上游地址（openai-compatible 的 baseURL 从 ~/.reader/settings.json 读，不信请求），
 *   去掉浏览器带来的 authorization，注入 `Authorization: Bearer <key>`。
 * Node（CLI、录制脚本）用 directTransport 直连，密钥由调用方给。测试用 networkGuardTransport，任何请求都抛错。
 */

export type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface LlmTransport {
  /** 为某个 provider 生成 fetch。upstreamBase 是该 provider 的上游根地址（不带结尾斜杠）。 */
  fetchFor(providerId: string, upstreamBase: string): FetchFn;
  /** true：密钥由传输层（dev bridge）注入，provider 只放占位密钥。 */
  injectsAuth: boolean;
  /** injectsAuth 为 false 时取密钥。返回 undefined 表示没有密钥（Ollama 之类可以不要）。 */
  apiKey?(providerId: string): Promise<string | undefined>;
}

export const BRIDGE_PREFIX = "/__llm";
export const BRIDGE_HEADER = "x-glossa-bridge";
/** 占位密钥：SDK 要求非空（网关没有密钥时会去找 Vercel OIDC），bridge 会去掉它换成真密钥。 */
export const BRIDGE_PLACEHOLDER_KEY = "via-glossa-bridge";

export const trimSlash = (s: string) => s.replace(/\/+$/, "");

const urlOf = (input: RequestInfo | URL): string =>
  typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

/**
 * 上游地址 → bridge 路径（不含 origin）。不以 upstreamBase 开头的地址抛错：bridge 只转发这个 provider 的上游。
 * 例：bridgePath("deepseek", "https://api.deepseek.com", "https://api.deepseek.com/chat/completions")
 *     === "/__llm/deepseek/chat/completions"
 */
export function bridgePath(providerId: string, upstreamBase: string, url: string): string {
  const base = trimSlash(upstreamBase);
  if (url !== base && !url.startsWith(`${base}/`) && !url.startsWith(`${base}?`)) {
    throw new TypeError(`bridge 只转发 ${providerId} 的上游 ${base}，拒绝：${url}`);
  }
  return `${BRIDGE_PREFIX}/${encodeURIComponent(providerId)}${url.slice(base.length)}`;
}

/** 浏览器 dev bridge 传输。origin 一般是 location.origin。 */
export function createBridgeTransport(opts: { origin: string; fetch?: FetchFn }): LlmTransport {
  const origin = trimSlash(opts.origin);
  const f: FetchFn = opts.fetch ?? ((i, init) => globalThis.fetch(i, init));
  return {
    injectsAuth: true,
    fetchFor(providerId, upstreamBase) {
      return async (input, init) => {
        const target = origin + bridgePath(providerId, upstreamBase, urlOf(input));
        const headers = new Headers(input instanceof Request ? input.headers : undefined);
        new Headers(init?.headers).forEach((v, k) => headers.set(k, v));
        // 密钥只在服务端注入；浏览器侧的占位 authorization 直接去掉。
        headers.delete("authorization");
        headers.set(BRIDGE_HEADER, "1");
        if (input instanceof Request) return f(new Request(target, input), { ...init, headers });
        return f(target, { ...init, headers });
      };
    },
  };
}

/** Node 直连。apiKey 按 provider 取，通常读环境变量。 */
export function directTransport(
  opts: { fetch?: FetchFn; apiKey?: (providerId: string) => Promise<string | undefined> | string | undefined } = {},
): LlmTransport {
  const f: FetchFn = opts.fetch ?? ((i, init) => globalThis.fetch(i, init));
  return {
    injectsAuth: false,
    fetchFor: () => f,
    apiKey: async (id) => (await opts.apiKey?.(id)) ?? undefined,
  };
}

/** 测试用：任何联网都抛「测试禁止联网」，防止漏掉录制回放时真的打到服务商。 */
export function networkGuardTransport(): LlmTransport {
  return {
    injectsAuth: true,
    fetchFor: (providerId) => async (input) => {
      throw new Error(`测试禁止联网（${providerId}）：${urlOf(input)}`);
    },
  };
}
