/**
 * dev bridge（设计 §11 第 12 条）：当作普通 Connect 中间件挂在本机 http 服务上测试，
 * 上游用另一个本机 http 服务假扮，钥匙串用假的。不联网。
 */
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ExecFileFn, type SecretStore, createBridgeMiddleware, fileCredentials, macKeychain } from "../dev/glossa-dev-bridge";

const listen = (s: Server) => new Promise<string>((ok) => s.listen(0, "127.0.0.1", () => ok(`http://localhost:${(s.address() as AddressInfo).port}`)));
const close = (s: Server) => new Promise<void>((ok) => s.close(() => ok()));

function fakeSecrets(initial: Record<string, string> = {}): SecretStore & { items: Map<string, string> } {
  const items = new Map(Object.entries(initial));
  return {
    kind: "keychain",
    items,
    get: async (id) => items.get(id) ?? null,
    set: async (id, k) => void items.set(id, k),
    delete: async (id) => void items.delete(id),
  };
}

interface UpSeen {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: string;
}

let home: string;
let upstream: Server;
let upstreamUrl: string;
let seen: UpSeen[];
/** SSE 测试：上游写完第一块后等这个信号再写第二块。 */
let releaseSecond: (() => void) | null;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "glossa-bridge-"));
  seen = [];
  releaseSecond = null;
  upstream = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
      if (req.url?.startsWith("/sse")) {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        res.write('data: {"n":1}\n\n');
        releaseSecond = () => res.end('data: {"n":2}\n\n');
        return;
      }
      res.writeHead(200, { "content-type": "application/json", "set-cookie": "a=b" });
      res.end(JSON.stringify({ ok: true, path: req.url }));
    });
  });
  upstreamUrl = await listen(upstream);
});

afterEach(async () => {
  await close(upstream);
  await rm(home, { recursive: true, force: true });
});

async function bridge(opts: { env?: Record<string, string>; secrets?: SecretStore; envFile?: string } = {}) {
  if (opts.envFile !== undefined) await writeFile(join(home, ".env.local"), opts.envFile);
  const mw = createBridgeMiddleware({
    envDir: home,
    home,
    env: opts.env ?? {},
    secrets: opts.secrets ?? fakeSecrets(),
    upstreams: { "vercel-gateway": upstreamUrl, deepseek: upstreamUrl },
  });
  const server = createServer((req: IncomingMessage, res: ServerResponse) =>
    mw(req, res, () => {
      res.statusCode = 404;
      res.end("next");
    }),
  );
  const base = await listen(server);
  const call = (path: string, init: RequestInit & { bridge?: boolean } = {}) => {
    const headers = new Headers(init.headers);
    if (init.bridge !== false) headers.set("x-glossa-bridge", "1");
    return fetch(`${base}${path}`, { ...init, headers });
  };
  return { base, call, server, done: () => close(server) };
}

describe("dev bridge：/__llm 转发", () => {
  it("去掉浏览器的 authorization，注入服务端密钥；去掉 cookie 和 bridge 头；保留查询串和请求体", async () => {
    const b = await bridge({ secrets: fakeSecrets({ "vercel-gateway": "vck_server_side_key_123456" }) });
    const res = await b.call("/__llm/vercel-gateway/v4/ai/language-model?x=1", {
      method: "POST",
      headers: { authorization: "Bearer via-glossa-bridge", cookie: "s=1", "content-type": "application/json", origin: b.base },
      body: JSON.stringify({ hello: "世界" }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: "POST", url: "/v4/ai/language-model?x=1", body: '{"hello":"世界"}' });
    expect(seen[0]!.headers.authorization).toBe("Bearer vck_server_side_key_123456");
    expect(seen[0]!.headers.cookie).toBeUndefined();
    expect(seen[0]!.headers["x-glossa-bridge"]).toBeUndefined();
    expect(seen[0]!.headers.origin).toBeUndefined();
    await b.done();
  });

  it("没有密钥：401 no_key，不访问上游", async () => {
    const b = await bridge();
    const res = await b.call("/__llm/deepseek/chat/completions", { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: { code: "no_key" } });
    expect(seen).toHaveLength(0);
    await b.done();
  });

  it("放行表以外的路径（含路径穿越）一律 404，不访问上游", async () => {
    const b = await bridge({ env: { DEEPSEEK_API_KEY: "sk-env-key-0000000000" } });
    for (const p of ["/__llm/deepseek/v1/files", "/__llm/deepseek/models/../admin", "/__llm/deepseek/%2e%2e/x", "/__llm/unknown/models", "/__llm/deepseek"]) {
      const res = await b.call(p);
      expect(res.status, p).toBe(404);
    }
    expect((await b.call("/__llm/deepseek/models")).status).toBe(200);
    expect(seen.map((s) => s.url)).toEqual(["/models"]);
    await b.done();
  });

  it("缺少 x-glossa-bridge 头、外来 Origin、跨站 Sec-Fetch-Site、非本机 Host：403", async () => {
    const b = await bridge({ env: { DEEPSEEK_API_KEY: "sk-env-key-0000000000" } });
    expect((await b.call("/__llm/deepseek/models", { bridge: false })).status).toBe(403);
    expect((await b.call("/__llm/deepseek/models", { headers: { origin: "http://evil.example" } })).status).toBe(403);
    expect((await b.call("/__llm/deepseek/models", { headers: { "sec-fetch-site": "cross-site" } })).status).toBe(403);
    expect((await b.call("/__glossa/llm/key/deepseek", { bridge: false })).status).toBe(403);
    expect((await b.call("/__glossa/settings", { method: "PUT", body: "{}", headers: { origin: "http://localhost:1" } })).status).toBe(403);
    // DNS rebinding：Host 不是本机
    const { request } = await import("node:http");
    const status = await new Promise<number>((ok) => {
      const r = request(`${b.base}/__glossa/settings`, { headers: { host: "evil.example", "x-glossa-bridge": "1" } }, (res) => {
        res.resume();
        ok(res.statusCode ?? 0);
      });
      r.end();
    });
    expect(status).toBe(403);
    // 同源请求正常
    expect((await b.call("/__llm/deepseek/models", { headers: { origin: b.base, "sec-fetch-site": "same-origin" } })).status).toBe(200);
    expect(seen).toHaveLength(1);
    await b.done();
  });

  it("SSE 逐块转发，不缓冲", async () => {
    const b = await bridge({ secrets: fakeSecrets({ deepseek: "sk-keychain-key-000000" }) });
    // 借用 deepseek 的放行路径：上游假服务对 /sse* 回 SSE。用 upstreams 覆盖把 /chat/completions 指过去。
    const mw = createBridgeMiddleware({
      envDir: home,
      home,
      env: {},
      secrets: fakeSecrets({ deepseek: "sk-keychain-key-000000" }),
      upstreams: { deepseek: `${upstreamUrl}/sse` },
    });
    const server = createServer((req, res) => mw(req, res, () => res.end()));
    const base = await listen(server);
    const res = await fetch(`${base}/__llm/deepseek/chat/completions`, { method: "POST", headers: { "x-glossa-bridge": "1" }, body: "{}" });
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const reader = res.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    // 第二块还没写：第一块已经到了，说明没有缓冲到流结束。
    expect(first).toBe('data: {"n":1}\n\n');
    expect(releaseSecond).not.toBeNull();
    releaseSecond!();
    let rest = "";
    for (let r = await reader.read(); !r.done; r = await reader.read()) rest += new TextDecoder().decode(r.value);
    expect(rest).toBe('data: {"n":2}\n\n');
    await close(server);
    await b.done();
  });
});

describe("dev bridge：密钥接口", () => {
  it("GET 只给状态和 4 位提示，永远不含密钥；PUT 保存、DELETE 清除", async () => {
    const secrets = fakeSecrets();
    const b = await bridge({ secrets });
    const s0 = await (await b.call("/__glossa/llm/key/vercel-gateway")).json();
    expect(s0).toMatchObject({ configured: false, source: null, hint: null, envVar: "AI_GATEWAY_API_KEY", store: "keychain" });

    const key = "vck_abcdefghijklmnopqrstuvwxyz_a1b2";
    const put = await b.call("/__glossa/llm/key/vercel-gateway", { method: "PUT", body: JSON.stringify({ apiKey: ` ${key} ` }) });
    expect(put.status).toBe(200);
    const putText = await put.text();
    expect(putText).not.toContain(key);
    expect(JSON.parse(putText)).toMatchObject({ configured: true, source: "keychain", hint: "…a1b2" });
    expect(secrets.items.get("vercel-gateway")).toBe(key);

    const getText = await (await b.call("/__glossa/llm/key/vercel-gateway")).text();
    expect(getText).not.toContain(key);
    expect(getText).not.toContain("abcdefgh");

    const del = await (await b.call("/__glossa/llm/key/vercel-gateway", { method: "DELETE" })).json();
    expect(del).toMatchObject({ configured: false, source: null });
    expect(secrets.items.size).toBe(0);

    expect((await b.call("/__glossa/llm/key/vercel-gateway", { method: "PUT", body: JSON.stringify({ apiKey: "has space" }) })).status).toBe(400);
    expect((await b.call("/__glossa/llm/key/nope")).status).toBe(404);
    await b.done();
  });

  it("环境变量优先：状态 source=env；PUT 返回 409；.env.local 同样算 env", async () => {
    const b = await bridge({ env: { AI_GATEWAY_API_KEY: "vck_from_process_env_9999" } });
    expect(await (await b.call("/__glossa/llm/key/vercel-gateway")).json()).toMatchObject({ configured: true, source: "env", envFile: false, hint: "…9999" });
    expect((await b.call("/__glossa/llm/key/vercel-gateway", { method: "PUT", body: JSON.stringify({ apiKey: "vck_x_123456789012" }) })).status).toBe(409);
    await b.done();

    const b2 = await bridge({ envFile: "DEEPSEEK_API_KEY=sk-from-dotenv-local-7777\nVITE_OTHER=1\n" });
    expect(await (await b2.call("/__glossa/llm/key/deepseek")).json()).toMatchObject({ configured: true, source: "env", envFile: true, hint: "…7777" });
    expect((await b2.call("/__glossa/llm/key/deepseek", { method: "PUT", body: JSON.stringify({ apiKey: "sk-x-1234567890123" }) })).status).toBe(409);
    // .env.local 的密钥也会注入
    await b2.call("/__llm/deepseek/models");
    expect(seen.at(-1)?.headers.authorization).toBe("Bearer sk-from-dotenv-local-7777");
    await b2.done();
  });

  it("credentials.json 后端：权限 0600，按 provider 存，清除后删掉条目", async () => {
    const store = fileCredentials(home);
    await store.set("deepseek", "sk-file-key-000000000");
    await store.set("vercel-gateway", "vck_file_key_000000000");
    const path = join(home, "credentials.json");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const json = JSON.parse(await readFile(path, "utf8"));
    expect(json.schemaVersion).toBe(1);
    expect(Object.keys(json.providers)).toEqual(["deepseek", "vercel-gateway"]);
    expect(await store.get("deepseek")).toBe("sk-file-key-000000000");
    await store.delete("deepseek");
    expect(await store.get("deepseek")).toBeNull();
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("macOS 钥匙串：用 security 命令、execFile 传参（不经 shell）", async () => {
    const calls: string[][] = [];
    let saved: string | null = null;
    const exec: ExecFileFn = async (file, args) => {
      calls.push([file, ...args]);
      if (args[0] === "add-generic-password") saved = args[args.indexOf("-w") + 1]!;
      if (args[0] === "find-generic-password") {
        if (!saved) throw Object.assign(new Error("not found"), { code: 44 });
        return { stdout: `${saved}\n` };
      }
      if (args[0] === "delete-generic-password") saved = null;
      return { stdout: "" };
    };
    const kc = macKeychain(exec);
    expect(await kc.get("deepseek")).toBeNull();
    await kc.set("deepseek", "sk-kc-123");
    expect(await kc.get("deepseek")).toBe("sk-kc-123");
    await kc.delete("deepseek");
    expect(await kc.get("deepseek")).toBeNull();
    expect(calls[1]!.slice(0, 7)).toEqual(["security", "add-generic-password", "-U", "-s", "glossa", "-a", "deepseek"]);
    expect(calls[0]).toEqual(["security", "find-generic-password", "-s", "glossa", "-a", "deepseek", "-w"]);
  });
});

describe("dev bridge：设置接口", () => {
  it("GET 返回默认设置；PUT 写 ~/.reader/settings.json（固定键序、保留未知字段、去掉 apiKey）；openai-compatible 的上游从这里读", async () => {
    const b = await bridge();
    const s = await (await b.call("/__glossa/settings")).json();
    expect(s).toMatchObject({ schemaVersion: 1, llm: { activeProvider: "vercel-gateway" }, onboarding: { status: "pending" } });

    s.llm.activeProvider = "openai-compatible";
    s.llm.providers = { "openai-compatible": { baseURL: `${upstreamUrl}/v1`, apiKey: "不该落盘" } };
    s.future = { keep: true };
    expect((await b.call("/__glossa/settings", { method: "PUT", body: JSON.stringify(s) })).status).toBe(204);
    const text = await readFile(join(home, "settings.json"), "utf8");
    expect(text.indexOf('"schemaVersion"')).toBeLessThan(text.indexOf('"llm"'));
    expect(text).toContain('"future"');
    expect(text).not.toContain("apiKey");

    expect((await b.call("/__glossa/settings", { method: "PUT", body: "不是 JSON" })).status).toBe(400);

    // openai-compatible 不需要密钥，baseURL 只认服务端设置
    const res = await b.call("/__llm/openai-compatible/models?from=browser");
    expect(res.status).toBe(200);
    expect(seen.at(-1)?.url).toBe("/v1/models?from=browser");
    expect(seen.at(-1)?.headers.authorization).toBeUndefined();
    await b.done();
  });

  it("上游连不上：502，消息里有错误码（客户端判为网络错误）", async () => {
    const b = await bridge();
    const s = await (await b.call("/__glossa/settings")).json();
    s.llm.providers = { "openai-compatible": { baseURL: "http://127.0.0.1:1/v1" } };
    await b.call("/__glossa/settings", { method: "PUT", body: JSON.stringify(s) });
    const res = await b.call("/__llm/openai-compatible/models");
    expect(res.status).toBe(502);
    expect(JSON.stringify(await res.json())).toMatch(/ECONNREFUSED/);
    await b.done();
  });

  it("非 bridge 路径交给下一个中间件", async () => {
    const b = await bridge();
    const res = await b.call("/index.html");
    expect(await res.text()).toBe("next");
    await b.done();
  });
});
