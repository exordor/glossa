/**
 * Glossa dev bridge：只在 `vite dev` 里存在的本机服务端（Vite 插件见 ./plugin.ts，apply: "serve"，生产构建没有它）。
 * 浏览器只和自己的 origin 说话；密钥只在这里（Node 端）出现，从不返回给浏览器、从不写日志。
 *
 *   ALL  /__llm/<providerId>/<rest>          转发到该 provider 的上游，服务端注入 Authorization: Bearer <key>
 *   GET|PUT|DELETE /__glossa/llm/key/<id>    密钥状态 / 保存 / 清除（GET 只回状态和 4 位提示，不回密钥）
 *   GET|PUT /__glossa/settings               ~/.reader/settings.json（经 @reader/core/node 的 NodeSettingsStore）
 *
 * 防止别的本机网页花你的额度：
 *   - 必须带请求头 x-glossa-bridge: 1（非简单请求头，跨源要先预检，bridge 不应答预检）；
 *   - Origin（有的话）必须等于本服务的 origin，Sec-Fetch-Site（有的话）必须是 same-origin；
 *   - Host 必须是本机回环地址（防 DNS rebinding）；
 *   - 每个 provider 只放行固定的路径。
 *
 * 密钥查找顺序（每个请求都重新查，设置页保存后不用重启）：
 *   环境变量 → 仓库根目录 .env.local（loadEnv，只按该变量名前缀加载，绝不用 VITE_ 前缀）→ 钥匙串 / credentials.json。
 */
import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { type IncomingMessage, type ServerResponse, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { join } from "node:path";
import { stableStringify } from "@reader/core";
import { NodeSettingsStore, readerHome } from "@reader/core/node";
import { parseSettings, serializeSettings } from "@reader/core";
import { BRIDGE_HEADER, BRIDGE_PREFIX, DEEPSEEK_ORIGIN, GATEWAY_ORIGIN, OLLAMA_BASE_URL, PROVIDER_IDS } from "@reader/llm";
import { loadEnv } from "vite";

/** 密钥存储后端。可注入，测试用假的。 */
export interface SecretStore {
  readonly kind: "keychain" | "file";
  get(providerId: string): Promise<string | null>;
  set(providerId: string, key: string): Promise<void>;
  delete(providerId: string): Promise<void>;
}

export type ExecFileFn = (file: string, args: string[]) => Promise<{ stdout: string }>;

const execFileP: ExecFileFn = (file, args) =>
  new Promise((ok, fail) => {
    execFile(file, args, { encoding: "utf8", timeout: 10_000 }, (err, stdout) => (err ? fail(err) : ok({ stdout })));
  });

export const KEYCHAIN_SERVICE = "glossa";

/**
 * macOS 钥匙串：用系统自带的 security 命令行，execFile 不经过 shell。
 * 注意（v0.1 可接受）：add-generic-password 的 -w 把密钥放在命令行参数里，同一台机器上的其他进程短暂可见（ps）。
 * 以后 Tauri 版换成 keyring crate。
 */
export function macKeychain(exec: ExecFileFn = execFileP): SecretStore {
  return {
    kind: "keychain",
    async get(id) {
      try {
        const { stdout } = await exec("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", id, "-w"]);
        const key = stdout.replace(/\r?\n$/, "");
        return key || null;
      } catch {
        return null; // 退出码 44：没有这一项
      }
    },
    async set(id, key) {
      await exec("security", ["add-generic-password", "-U", "-s", KEYCHAIN_SERVICE, "-a", id, "-l", `Glossa · ${id}`, "-w", key]);
    },
    async delete(id) {
      try {
        await exec("security", ["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", id]);
      } catch {
        // 本来就没有
      }
    },
  };
}

interface CredentialsFile {
  schemaVersion: number;
  providers: Record<string, { apiKey?: string; [k: string]: unknown }>;
  [k: string]: unknown;
}

/** 其他系统：~/.reader/credentials.json，权限 0600（只有自己能读写）。明文，v0.1 开发期用。 */
export function fileCredentials(home: string = readerHome()): SecretStore {
  const path = join(home, "credentials.json");
  const read = async (): Promise<CredentialsFile> => {
    try {
      const raw = JSON.parse(await readFile(path, "utf8")) as Partial<CredentialsFile>;
      return { ...raw, schemaVersion: 1, providers: typeof raw.providers === "object" && raw.providers ? raw.providers : {} };
    } catch {
      return { schemaVersion: 1, providers: {} };
    }
  };
  const write = async (c: CredentialsFile) => {
    await mkdir(home, { recursive: true });
    const tmp = `${path}.tmp-${process.pid}`;
    await writeFile(tmp, stableStringify(c, ["schemaVersion", "providers"]), { encoding: "utf8", mode: 0o600 });
    await chmod(tmp, 0o600); // umask 可能去掉了位，再设一次
    await rename(tmp, path);
  };
  return {
    kind: "file",
    async get(id) {
      const k = (await read()).providers[id]?.apiKey;
      return typeof k === "string" && k ? k : null;
    },
    async set(id, key) {
      const c = await read();
      c.providers[id] = { ...(c.providers[id] ?? {}), apiKey: key };
      await write(c);
    },
    async delete(id) {
      const c = await read();
      if (!c.providers[id]) return;
      const { apiKey: _, ...rest } = c.providers[id]!;
      if (Object.keys(rest).length) c.providers[id] = rest;
      else delete c.providers[id];
      await write(c);
    },
  };
}

/** 一个 provider 的转发规则。base 为 null 时从设置里读（openai-compatible）。 */
interface ProviderRoute {
  envVar: string;
  requiresKey: boolean;
  base: string | null;
  /** 放行的路径：以 "/" 结尾的是前缀，否则精确匹配（相对 base）。 */
  paths: string[];
}

export const PROVIDER_ROUTES: Record<string, ProviderRoute> = {
  [PROVIDER_IDS.gateway]: {
    envVar: "AI_GATEWAY_API_KEY",
    requiresKey: true,
    base: GATEWAY_ORIGIN,
    paths: ["/v4/ai/", "/v1/models", "/v1/models/", "/v1/credits", "/v1/generation"],
  },
  [PROVIDER_IDS.deepseek]: {
    envVar: "DEEPSEEK_API_KEY",
    requiresKey: true,
    base: DEEPSEEK_ORIGIN,
    paths: ["/chat/completions", "/models", "/user/balance"],
  },
  [PROVIDER_IDS.openaiCompatible]: {
    envVar: "OPENAI_COMPATIBLE_API_KEY",
    requiresKey: false,
    base: null,
    paths: ["/chat/completions", "/models"],
  },
};

export type KeySource = "env" | "keychain" | "file" | null;

/** GET /__glossa/llm/key/<id> 的返回。永远不含密钥本身。 */
export interface KeyStatusBody {
  providerId: string;
  configured: boolean;
  source: KeySource;
  /** 末 4 位提示，如「…a1b2」；密钥太短时不给。 */
  hint: string | null;
  envVar: string;
  /** source 为 env 时：true 表示来自 .env.local，false 表示来自进程环境变量。 */
  envFile: boolean;
  /** 设置页保存时会写到哪里。 */
  store: "keychain" | "file";
  requiresKey: boolean;
}

export interface BridgeOptions {
  /** .env.local 所在目录（仓库根目录）。 */
  envDir: string;
  /** vite 的 mode（loadEnv 用）。 */
  mode?: string;
  /** ~/.reader；默认 readerHome()（READER_HOME 可覆盖）。 */
  home?: string;
  /** 进程环境变量；默认 process.env。 */
  env?: Record<string, string | undefined>;
  /** 密钥存储；默认 macOS 用钥匙串，其他系统用 credentials.json。 */
  secrets?: SecretStore;
  /** 测试用：覆盖 provider 的上游地址。 */
  upstreams?: Partial<Record<string, string>>;
}

type Next = (err?: unknown) => void;
export type BridgeMiddleware = (req: IncomingMessage, res: ServerResponse, next: Next) => void;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const MAX_BODY = 1 << 20;
/** 不转发给上游的请求头：逐跳头、浏览器身份信息、bridge 自己的标记。 */
const DROP_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "upgrade",
  "te",
  "trailer",
  "authorization",
  "cookie",
  "origin",
  "referer",
  "accept-encoding",
  BRIDGE_HEADER,
]);
const DROP_RESPONSE_HEADERS = new Set(["connection", "keep-alive", "transfer-encoding", "set-cookie", "proxy-authenticate", "trailer", "upgrade"]);

function sendJson(res: ServerResponse, status: number, body: unknown) {
  const text = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.setHeader(BRIDGE_HEADER, "1");
  res.end(text);
}

const fail = (res: ServerResponse, status: number, code: string, message: string) => sendJson(res, status, { error: { code, type: code, message } });

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((ok, bad) => {
    let size = 0;
    const parts: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        bad(new Error("请求体过大"));
        req.destroy();
      } else parts.push(c);
    });
    req.on("end", () => ok(Buffer.concat(parts).toString("utf8")));
    req.on("error", bad);
  });
}

/** 末 4 位提示。12 位以下的密钥不给提示，免得泄露太多。 */
export const keyHint = (key: string) => (key.length >= 12 ? `…${key.slice(-4)}` : null);

/** 守卫：bridge 头、Origin、Sec-Fetch-Site、Host。通过返回 null，否则返回拒绝原因。 */
function guard(req: IncomingMessage): string | null {
  const host = req.headers.host ?? "";
  const hostname = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0]!;
  if (!LOOPBACK_HOSTS.has(hostname)) return "只接受本机地址访问";
  if (req.headers[BRIDGE_HEADER] !== "1") return `缺少请求头 ${BRIDGE_HEADER}`;
  const origin = req.headers.origin;
  if (origin !== undefined && origin !== `http://${host}` && origin !== `https://${host}`) return "Origin 不是本服务";
  const site = req.headers["sec-fetch-site"];
  if (site !== undefined && site !== "same-origin") return "跨站请求被拒绝";
  return null;
}

/** 路径安全检查 + 放行表。rest 是去掉 /__llm/<id> 之后的部分（不含查询串）。 */
function pathAllowed(route: ProviderRoute, rest: string): boolean {
  if (!rest.startsWith("/") || rest.includes("..") || rest.includes("//") || rest.includes("\\") || /%(2e|2f|5c)/i.test(rest)) return false;
  return route.paths.some((p) => (p.endsWith("/") ? rest.startsWith(p) && rest.length > p.length : rest === p));
}

export function createBridgeMiddleware(opts: BridgeOptions): BridgeMiddleware {
  const env = opts.env ?? process.env;
  const mode = opts.mode ?? "development";
  const home = opts.home ?? readerHome(env);
  const secrets = opts.secrets ?? (process.platform === "darwin" ? macKeychain() : fileCredentials(home));
  const settingsStore = new NodeSettingsStore(home);

  /** 查密钥：环境变量 → .env.local → 钥匙串 / 文件。 */
  async function lookupKey(providerId: string, route: ProviderRoute): Promise<{ key: string; source: Exclude<KeySource, null>; envFile: boolean } | null> {
    const fromEnv = env[route.envVar];
    if (fromEnv) return { key: fromEnv, source: "env", envFile: false };
    // 前缀就是变量名本身：只加载这一个变量。loadEnv 也会带上 process.env 里的同名变量，这里已经查过。
    const fromFile = loadEnv(mode, opts.envDir, route.envVar)[route.envVar];
    if (fromFile) return { key: fromFile, source: "env", envFile: true };
    const stored = await secrets.get(providerId);
    if (stored) return { key: stored, source: secrets.kind, envFile: false };
    return null;
  }

  async function keyStatus(providerId: string, route: ProviderRoute): Promise<KeyStatusBody> {
    const found = await lookupKey(providerId, route);
    return {
      providerId,
      configured: Boolean(found),
      source: found?.source ?? null,
      hint: found ? keyHint(found.key) : null,
      envVar: route.envVar,
      envFile: found?.envFile ?? false,
      store: secrets.kind,
      requiresKey: route.requiresKey,
    };
  }

  async function upstreamBase(providerId: string, route: ProviderRoute): Promise<string> {
    const override = opts.upstreams?.[providerId];
    if (override) return override.replace(/\/+$/, "");
    if (route.base) return route.base;
    // openai-compatible：baseURL 只从服务端的设置文件读，不信任请求。
    const s = await settingsStore.load();
    const b = s.llm.providers[providerId]?.baseURL;
    return (typeof b === "string" && b ? b : OLLAMA_BASE_URL).replace(/\/+$/, "");
  }

  async function handleKey(req: IncomingMessage, res: ServerResponse, providerId: string) {
    const route = PROVIDER_ROUTES[providerId];
    if (!route) return fail(res, 404, "unknown_provider", `未知的服务商：${providerId}`);
    if (req.method === "GET") return sendJson(res, 200, await keyStatus(providerId, route));
    if (req.method === "PUT") {
      const found = await lookupKey(providerId, route);
      if (found?.source === "env") {
        return fail(res, 409, "env_override", `密钥来自环境变量 ${route.envVar}${found.envFile ? "（.env.local）" : ""}，环境变量优先，请在那里修改`);
      }
      let apiKey: unknown;
      try {
        apiKey = (JSON.parse(await readBody(req)) as { apiKey?: unknown }).apiKey;
      } catch {
        return fail(res, 400, "bad_request", "请求体必须是 JSON：{ apiKey }");
      }
      const key = typeof apiKey === "string" ? apiKey.trim() : "";
      // 密钥会进 HTTP 请求头：拒绝空白和控制字符。
      if (!key || key.length > 4096 || /[\s\x00-\x1f\x7f]/.test(key)) return fail(res, 400, "bad_key", "密钥格式不对");
      await secrets.set(providerId, key);
      return sendJson(res, 200, await keyStatus(providerId, route));
    }
    if (req.method === "DELETE") {
      await secrets.delete(providerId);
      return sendJson(res, 200, await keyStatus(providerId, route));
    }
    return fail(res, 405, "method_not_allowed", "不支持的方法");
  }

  async function handleSettings(req: IncomingMessage, res: ServerResponse) {
    if (req.method === "GET") {
      const s = await settingsStore.load();
      res.statusCode = 200;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.setHeader("cache-control", "no-store");
      res.setHeader(BRIDGE_HEADER, "1");
      return res.end(serializeSettings(s));
    }
    if (req.method === "PUT") {
      let parsed;
      try {
        parsed = parseSettings(await readBody(req));
      } catch {
        return fail(res, 400, "bad_settings", "设置不是合法的 JSON 对象");
      }
      await settingsStore.save(parsed);
      res.statusCode = 204;
      res.setHeader(BRIDGE_HEADER, "1");
      return res.end();
    }
    return fail(res, 405, "method_not_allowed", "不支持的方法");
  }

  async function handleProxy(req: IncomingMessage, res: ServerResponse, providerId: string, rest: string, search: string) {
    const route = PROVIDER_ROUTES[providerId];
    if (!route || !pathAllowed(route, rest)) return fail(res, 404, "not_allowed", "bridge 不转发这个地址");
    const found = await lookupKey(providerId, route);
    if (!found && route.requiresKey) return fail(res, 401, "no_key", "还没有配置 API 密钥");
    let target: URL;
    try {
      target = new URL(`${await upstreamBase(providerId, route)}${rest}${search}`);
    } catch {
      return fail(res, 400, "bad_base_url", "服务地址不合法");
    }
    if (target.protocol !== "https:" && target.protocol !== "http:") return fail(res, 400, "bad_base_url", "服务地址必须是 http 或 https");

    const headers: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined || DROP_REQUEST_HEADERS.has(k) || k.startsWith("sec-") || k.startsWith("proxy-")) continue;
      headers[k] = v;
    }
    if (found) headers.authorization = `Bearer ${found.key}`;

    const send = target.protocol === "https:" ? httpsRequest : httpRequest;
    const up = send(target, { method: req.method ?? "GET", headers }, (upRes) => {
      res.statusCode = upRes.statusCode ?? 502;
      for (const [k, v] of Object.entries(upRes.headers)) if (v !== undefined && !DROP_RESPONSE_HEADERS.has(k)) res.setHeader(k, v);
      // SSE：立即发出响应头，逐块转发，不缓冲。
      res.setHeader("x-accel-buffering", "no");
      res.flushHeaders();
      upRes.on("data", (chunk: Buffer) => res.write(chunk));
      upRes.on("end", () => res.end());
      upRes.on("error", () => res.destroy());
    });
    up.setNoDelay?.(true);
    up.on("error", (err: NodeJS.ErrnoException) => {
      if (res.headersSent) return void res.destroy();
      // 错误码放进消息里（ECONNREFUSED 等），客户端据此判断为网络错误。不带请求头，不会带出密钥。
      fail(res, 502, "bridge_upstream", `连不上上游 ${target.host}：${err.code ?? err.message}`);
    });
    // 浏览器取消（reader.llm.cancel → AbortSignal）时，停掉上游请求，不再花 token。
    res.on("close", () => {
      if (!res.writableFinished) up.destroy();
    });
    req.pipe(up);
  }

  return (req, res, next) => {
    const url = req.url ?? "";
    const isLlm = url === BRIDGE_PREFIX || url.startsWith(`${BRIDGE_PREFIX}/`);
    const isGlossa = url.startsWith("/__glossa/");
    if (!isLlm && !isGlossa) return next();
    const denied = guard(req);
    if (denied) return fail(res, 403, "forbidden", denied);

    const q = url.indexOf("?");
    const path = q >= 0 ? url.slice(0, q) : url;
    const search = q >= 0 ? url.slice(q) : "";
    const run = async () => {
      if (isLlm) {
        const m = /^\/__llm\/([a-z0-9-]+)(\/.*)?$/.exec(path);
        if (!m) return fail(res, 404, "not_allowed", "bridge 不转发这个地址");
        return handleProxy(req, res, m[1]!, m[2] ?? "", search);
      }
      const key = /^\/__glossa\/llm\/key\/([a-z0-9-]+)$/.exec(path);
      if (key) return handleKey(req, res, key[1]!);
      if (path === "/__glossa/settings") return handleSettings(req, res);
      return fail(res, 404, "not_found", "没有这个接口");
    };
    run().catch((e: Error) => {
      if (res.headersSent) return void res.destroy();
      fail(res, 500, "bridge_error", e.message);
    });
  };
}
