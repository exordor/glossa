/**
 * 三个内置 provider（都以 owner "builtin" 注册到 registry 的 llmProvider）：
 *   vercel-gateway     Vercel AI Gateway（默认），createGateway；密钥 AI_GATEWAY_API_KEY。
 *   deepseek           DeepSeek 官方 API（OpenAI 兼容，https://api.deepseek.com）；密钥 DEEPSEEK_API_KEY。
 *   openai-compatible  自定义 baseURL（OpenAI、Ollama、OpenRouter…），密钥可选。
 * 所有请求经注入的 transport.fetchFor(providerId, upstreamBase) 发出，浏览器里即 dev bridge /__llm/<providerId>/…
 */
import type { LlmCredits, LlmProviderContribution, ModelCapability, ProviderSettings, Registration, Registry } from "@reader/core";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createGateway } from "ai";
import { type SdkLanguageModel, createLlmClient, getJson } from "./client.js";
import { fromGatewayModel, fromOpenAiModel, modelListEntries } from "./capabilities.js";
import {
  DEEPSEEK_CAPABILITIES,
  DEEPSEEK_DEFAULT_ALIASES,
  DEEPSEEK_ORIGIN,
  GATEWAY_CAPABILITIES,
  GATEWAY_DEFAULT_ALIASES,
  GATEWAY_ORIGIN,
  OLLAMA_BASE_URL,
  OPENAI_COMPATIBLE_DEFAULT_ALIASES,
} from "./defaults.js";
import type { RecordReplayOptions } from "./record-replay.js";
import { BRIDGE_PLACEHOLDER_KEY, type LlmTransport, trimSlash } from "./transport.js";

export const PROVIDER_IDS = { gateway: "vercel-gateway", deepseek: "deepseek", openaiCompatible: "openai-compatible" } as const;

export interface BuiltinProviderOptions {
  transport: LlmTransport;
  /** 录制回放；不传时取环境变量 GLOSSA_LLM_RECORDINGS（应用里默认 off）。 */
  recordings?: RecordReplayOptions;
}

async function keyFor(transport: LlmTransport, providerId: string): Promise<string | undefined> {
  return transport.injectsAuth ? BRIDGE_PLACEHOLDER_KEY : await transport.apiKey?.(providerId);
}

const authHeaders = (key: string | undefined): Record<string, string> => (key ? { authorization: `Bearer ${key}` } : {});

/** Vercel AI Gateway。upstreamBase 是网关 origin：/v4/ai/*、/v1/models、/v1/credits 都在它下面。 */
export function vercelGatewayProvider(opts: BuiltinProviderOptions): LlmProviderContribution {
  const id = PROVIDER_IDS.gateway;
  return {
    id,
    name: "Vercel AI Gateway",
    keyEnvVar: "AI_GATEWAY_API_KEY",
    requiresKey: true,
    docsUrl: "https://vercel.com/docs/ai-gateway",
    defaults: (): ProviderSettings => ({
      kind: id,
      aliases: structuredClone(GATEWAY_DEFAULT_ALIASES),
      routing: {},
      capabilities: structuredClone(GATEWAY_CAPABILITIES),
    }),
    async create(settings) {
      const fetchFn = opts.transport.fetchFor(id, GATEWAY_ORIGIN);
      const key = await keyFor(opts.transport, id);
      // apiKey 必须非空，否则 SDK 会去找 Vercel OIDC。
      const gw = createGateway({ apiKey: key ?? BRIDGE_PLACEHOLDER_KEY, baseURL: `${GATEWAY_ORIGIN}/v4/ai`, fetch: fetchFn });
      return createLlmClient({
        providerId: id,
        settings,
        languageModel: (m) => gw(m) as SdkLanguageModel,
        providerOptions: () => (settings.routing && Object.keys(settings.routing).length ? { gateway: settings.routing } : undefined),
        generationId: (md) => {
          const g = (md as { gateway?: { generationId?: unknown } } | undefined)?.gateway?.generationId;
          return typeof g === "string" ? g : undefined;
        },
        async listModels() {
          const body = await getJson(fetchFn, `${GATEWAY_ORIGIN}/v1/models`, authHeaders(key));
          return modelListEntries(body)
            .map((e) => fromGatewayModel(e))
            .filter((c): c is ModelCapability => c !== null);
        },
        async credits(): Promise<LlmCredits | null> {
          const c = await gw.getCredits();
          return { balance: String(c.balance), totalUsed: String(c.totalUsed), currency: "USD" };
        },
        ...(opts.recordings ? { recordings: opts.recordings } : {}),
      });
    },
  };
}

interface OpenAiLikeSpec {
  id: string;
  name: string;
  keyEnvVar?: string;
  requiresKey: boolean;
  docsUrl?: string;
  defaults(): ProviderSettings;
  baseURL(settings: ProviderSettings): string;
  credits?(fetchFn: (u: string, i?: RequestInit) => Promise<Response>, base: string, key: string | undefined): Promise<LlmCredits | null>;
}

function openAiLikeProvider(spec: OpenAiLikeSpec, opts: BuiltinProviderOptions): LlmProviderContribution {
  const { id } = spec;
  const out: LlmProviderContribution = {
    id,
    name: spec.name,
    requiresKey: spec.requiresKey,
    defaults: spec.defaults,
    async create(settings) {
      const base = trimSlash(spec.baseURL(settings));
      const fetchFn = opts.transport.fetchFor(id, base);
      const key = await keyFor(opts.transport, id);
      const provider = createOpenAICompatible({
        name: id,
        baseURL: base,
        ...(key ? { apiKey: key } : {}),
        fetch: fetchFn,
        includeUsage: true,
      });
      return createLlmClient({
        providerId: id,
        settings,
        languageModel: (m) => provider.chatModel(m) as SdkLanguageModel,
        async listModels() {
          const body = await getJson(fetchFn, `${base}/models`, authHeaders(key));
          const known = settings.capabilities ?? {};
          return modelListEntries(body)
            .map((e) => fromOpenAiModel(e, known[(e as { id?: string })?.id ?? ""]))
            .filter((c): c is ModelCapability => c !== null);
        },
        ...(spec.credits ? { credits: () => spec.credits!(fetchFn, base, key) } : {}),
        ...(opts.recordings ? { recordings: opts.recordings } : {}),
      });
    },
  };
  if (spec.keyEnvVar) out.keyEnvVar = spec.keyEnvVar;
  if (spec.docsUrl) out.docsUrl = spec.docsUrl;
  return out;
}

/** DeepSeek 官方 API。余额接口 GET /user/balance（未在沙箱核实，失败时返回 null）。 */
export function deepseekProvider(opts: BuiltinProviderOptions): LlmProviderContribution {
  return openAiLikeProvider(
    {
      id: PROVIDER_IDS.deepseek,
      name: "DeepSeek",
      keyEnvVar: "DEEPSEEK_API_KEY",
      requiresKey: true,
      docsUrl: "https://platform.deepseek.com/api_keys",
      defaults: () => ({
        kind: PROVIDER_IDS.deepseek,
        aliases: structuredClone(DEEPSEEK_DEFAULT_ALIASES),
        capabilities: structuredClone(DEEPSEEK_CAPABILITIES),
      }),
      // baseURL 固定为官方地址，不读设置：bridge 只按这个地址转发。
      baseURL: () => DEEPSEEK_ORIGIN,
      async credits(fetchFn, base, key) {
        const body = (await getJson(fetchFn, `${base}/user/balance`, authHeaders(key))) as {
          balance_infos?: Array<{ currency?: string; total_balance?: string }>;
        } | null;
        const b = body?.balance_infos?.[0];
        if (!b?.total_balance) return null;
        const out: LlmCredits = { balance: b.total_balance, totalUsed: null };
        if (b.currency) out.currency = b.currency;
        return out;
      },
    },
    opts,
  );
}

/** OpenAI 兼容：baseURL 来自设置（默认 Ollama）。dev bridge 在服务端读同一份设置决定转发目标。 */
export function openAiCompatibleProvider(opts: BuiltinProviderOptions): LlmProviderContribution {
  return openAiLikeProvider(
    {
      id: PROVIDER_IDS.openaiCompatible,
      name: "OpenAI 兼容",
      // 密钥可选（Ollama 不需要）；需要时也可以写进环境变量。
      keyEnvVar: "OPENAI_COMPATIBLE_API_KEY",
      requiresKey: false,
      defaults: () => ({
        kind: PROVIDER_IDS.openaiCompatible,
        aliases: structuredClone(OPENAI_COMPATIBLE_DEFAULT_ALIASES),
        baseURL: OLLAMA_BASE_URL,
        capabilities: {},
      }),
      baseURL: (s) => (typeof s.baseURL === "string" && s.baseURL ? s.baseURL : OLLAMA_BASE_URL),
    },
    opts,
  );
}

/** 注册三个内置 provider，返回各自的 Registration（dispose 可撤销）。 */
export function registerBuiltinLlmProviders(registry: Registry, opts: BuiltinProviderOptions): Registration[] {
  return [vercelGatewayProvider(opts), deepseekProvider(opts), openAiCompatibleProvider(opts)].map((p) =>
    registry.register("llmProvider", p, "builtin"),
  );
}
