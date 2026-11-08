/**
 * 设置页「AI 模型」：服务商、API 密钥、OpenAI 兼容的服务地址、模型别名（模型 + 思考强度）、能力、余额、一键测试。
 * 只经 reader.llm（@reader/core 的 LlmService）和 dev bridge 的密钥接口，不直接碰 AI SDK。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AliasBinding,
  GlobalSettings,
  LlmCredits,
  LlmErrorInfo,
  LlmProviderInfo,
  LlmService,
  ModelAlias,
  ModelCapability,
  ProviderSettings,
  ReasoningLevel,
} from "@reader/core";
import { isLlmError } from "@reader/core";
import { Icon } from "./icons";
import { type KeyStatus, NO_BRIDGE_TEXT, clearKey, getBridgeState, keyStatus, llmErrorText, saveKey, seconds, shortTokens } from "./llm";

const ALIASES: Array<{ alias: ModelAlias; label: string }> = [
  { alias: "fast", label: "快速" },
  { alias: "smart", label: "深入" },
  { alias: "vision", label: "看图" },
  { alias: "image", label: "生成图片" },
];

const REASONING: Array<{ value: ReasoningLevel | ""; label: string }> = [
  { value: "", label: "默认" },
  { value: "none", label: "关" },
  { value: "low", label: "低" },
  { value: "high", label: "高" },
  { value: "max", label: "最大" },
];

const CUSTOM = "__custom__";
const isDeepSeekProvider = (id: string) => id === "vercel-gateway" || id === "deepseek";

/** 密钥状态行。 */
export function keyStatusText(s: KeyStatus | null): string {
  if (!s) return "";
  if (!s.configured) return s.requiresKey ? "未配置" : "未配置（可选：本地服务如 Ollama 不需要密钥）";
  if (s.source === "env") return `已配置（来自${s.envFile ? " .env.local 的" : "环境变量"} ${s.envVar}）`;
  const where = s.source === "keychain" ? "保存在系统钥匙串" : "保存在本机 ~/.reader/credentials.json";
  return `已配置（${s.hint ? `${s.hint}，` : ""}${where}）`;
}

/** 一键测试：固定提示词走 fast，流式显示，可取消。设置页和首次启动引导共用。 */
export function AiTest({ llm, providerId, onSuccess }: { llm: LlmService; providerId: string; onSuccess?: () => void }) {
  const [phase, setPhase] = useState<"idle" | "running" | "done" | "error">("idle");
  const [text, setText] = useState("");
  const [summary, setSummary] = useState("");
  const [error, setError] = useState<LlmErrorInfo | null>(null);
  const runRef = useRef<string | null>(null);

  useEffect(
    () => () => {
      if (runRef.current) void llm.cancel(runRef.current);
    },
    [llm],
  );

  async function start() {
    const runId = crypto.randomUUID();
    runRef.current = runId;
    setPhase("running");
    setText("");
    setSummary("");
    setError(null);
    let acc = "";
    let model = "";
    for await (const c of llm.test("fast", { runId, providerId })) {
      if (runRef.current !== runId) return;
      if (c.type === "start") model = c.modelId;
      else if (c.type === "text") setText((acc += c.delta));
      else if (c.type === "finish") {
        const u = c.usage;
        const tokens = u.inputTokens !== undefined || u.outputTokens !== undefined ? ` · 输入 ${u.inputTokens ?? "?"} / 输出 ${u.outputTokens ?? "?"} token` : "";
        setSummary(`连接正常 · ${model} · 首字 ${seconds(c.firstChunkMs)} · 共 ${seconds(c.durationMs)}${tokens}`);
        setPhase("done");
        onSuccess?.();
      } else if (c.type === "error") {
        setError(c.error);
        setPhase("error");
      }
    }
    if (runRef.current === runId) runRef.current = null;
  }

  function cancel() {
    if (runRef.current) void llm.cancel(runRef.current);
  }

  return (
    <div className="ai-test">
      <div className="ai-test-actions">
        {phase === "running" ? (
          <>
            <button className="btn" disabled>
              <Icon name="st-running" className="rc-spin" /> 测试中…
            </button>
            <button className="btn" onClick={cancel}>
              取消
            </button>
          </>
        ) : (
          <button className="btn btn-primary" onClick={() => void start()}>
            {phase === "error" ? "重试" : "一键测试"}
          </button>
        )}
      </div>
      {(text || phase === "running") && (
        <div className="ai-test-output" aria-live="polite" aria-busy={phase === "running"}>
          {text || "等待回复…"}
        </div>
      )}
      {phase === "done" && (
        <p className="ai-test-ok" role="status">
          ✓ {summary}
        </p>
      )}
      {phase === "error" && error && (
        <p className="ai-test-error" role="alert">
          <Icon name="st-failed" /> {llmErrorText(error)}
        </p>
      )}
    </div>
  );
}

/** 密钥输入 + 保存 / 清除 + 状态行。设置页和引导共用。 */
export function KeyField({
  provider,
  status,
  onChange,
}: {
  provider: LlmProviderInfo;
  status: KeyStatus | null;
  onChange: (s: KeyStatus) => void;
}) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fromEnv = status?.source === "env";

  async function act(fn: () => Promise<KeyStatus>) {
    setBusy(true);
    setError(null);
    try {
      onChange(await fn());
      setValue("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="st-field">
      <label className="st-label" htmlFor={`key-${provider.id}`}>
        API 密钥
      </label>
      <div className="st-row">
        <input
          id={`key-${provider.id}`}
          className="st-input"
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder={fromEnv ? "由环境变量提供" : status?.configured ? "输入新密钥以替换" : provider.requiresKey ? "粘贴密钥" : "可选"}
          disabled={fromEnv || busy}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && value.trim()) void act(() => saveKey(provider.id, value));
          }}
        />
        <button className="btn" disabled={fromEnv || busy || !value.trim()} onClick={() => void act(() => saveKey(provider.id, value))}>
          保存
        </button>
        <button className="btn" disabled={fromEnv || busy || !status?.configured} onClick={() => void act(() => clearKey(provider.id))}>
          清除
        </button>
      </div>
      <p className="st-help" data-state={status?.configured ? "ok" : "none"}>
        {keyStatusText(status)}
        {provider.docsUrl && (
          <>
            {" · "}
            <a href={provider.docsUrl} target="_blank" rel="noreferrer">
              获取密钥 <Icon name="open-external" />
            </a>
          </>
        )}
      </p>
      <p className="st-help">密钥只保存在本机，不会写进书或仓库。</p>
      {error && (
        <p className="st-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function modelOptions(providerId: string, ps: ProviderSettings): ModelCapability[] {
  const all = Object.values(ps.capabilities ?? {});
  // 网关的模型列表有几百个：默认只列 DeepSeek，其余用「其他」手填。
  const list = providerId === "vercel-gateway" ? all.filter((c) => c.modelId.startsWith("deepseek/")) : all;
  return list.sort((a, b) => a.modelId.localeCompare(b.modelId));
}

function CapabilityChips({ cap }: { cap: ModelCapability | undefined }) {
  if (!cap) return <span className="st-chip">能力未知（可刷新模型信息）</span>;
  const price = cap.pricing ? `$${cap.pricing.inputPerMTok} / $${cap.pricing.outputPerMTok} 每百万 token` : "未知";
  return (
    <>
      <span className="st-chip" data-on={cap.input.image}>
        看图 {cap.input.image ? "✓" : "✗"}
      </span>
      <span className="st-chip">上下文 {shortTokens(cap.contextWindow)}</span>
      <span className="st-chip">单价 {price}</span>
    </>
  );
}

function AliasRow({
  providerId,
  alias,
  label,
  ps,
  onSave,
}: {
  providerId: string;
  alias: ModelAlias;
  label: string;
  ps: ProviderSettings;
  onSave: (b: AliasBinding | null) => void;
}) {
  const binding = ps.aliases[alias];
  const options = modelOptions(providerId, ps);
  const known = binding ? options.some((o) => o.modelId === binding.model) : true;
  const [custom, setCustom] = useState<string | null>(null);
  const selectValue = custom !== null ? CUSTOM : binding ? binding.model : "";
  const cap = binding ? ps.capabilities?.[binding.model] : undefined;
  const id = `alias-${alias}`;

  return (
    <div className="st-alias" data-alias={alias}>
      <label className="st-alias-name" htmlFor={id}>
        {label} <code>{alias}</code>
      </label>
      <div className="st-row">
        <select
          id={id}
          className="st-select"
          value={selectValue}
          onChange={(e) => {
            const v = e.target.value;
            if (v === CUSTOM) return setCustom(binding?.model ?? "");
            setCustom(null);
            onSave(v ? { ...(binding ?? {}), model: v } : null);
          }}
        >
          <option value="">未配置</option>
          {options.map((o) => (
            <option key={o.modelId} value={o.modelId}>
              {o.modelId}
            </option>
          ))}
          {binding && !known && <option value={binding.model}>{binding.model}</option>}
          <option value={CUSTOM}>其他（手动填写）…</option>
        </select>
        <label className="st-inline-label">
          思考
          <select
            className="st-select st-select-sm"
            aria-label={`${label}的思考强度`}
            disabled={!binding}
            value={binding?.reasoning ?? ""}
            onChange={(e) => {
              if (!binding) return;
              const { reasoning: _, ...rest } = binding;
              const v = e.target.value as ReasoningLevel | "";
              onSave(v ? { ...rest, reasoning: v } : rest);
            }}
          >
            {REASONING.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      {custom !== null && (
        <div className="st-row">
          <input
            className="st-input"
            aria-label={`${label}的模型 id`}
            placeholder={providerId === "vercel-gateway" ? "如 deepseek/deepseek-v4-pro-0813" : "模型 id"}
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
          />
          <button
            className="btn"
            disabled={!custom.trim()}
            onClick={() => {
              onSave({ ...(binding ?? {}), model: custom.trim() });
              setCustom(null);
            }}
          >
            确定
          </button>
          <button className="btn" onClick={() => setCustom(null)}>
            取消
          </button>
        </div>
      )}
      <div className="st-chips">
        {binding ? (
          <CapabilityChips cap={cap} />
        ) : (
          <span className="st-chip">
            {alias === "image" && isDeepSeekProvider(providerId) ? "DeepSeek 不提供图像生成，此别名不可用" : "未配置：用到这个别名的动作不可用"}
          </span>
        )}
      </div>
    </div>
  );
}

export function Settings({ llm, onClose }: { llm: LlmService; onClose: () => void }) {
  const [settings, setSettings] = useState<GlobalSettings | null>(null);
  const [providers, setProviders] = useState<LlmProviderInfo[]>([]);
  const [ps, setPs] = useState<ProviderSettings | null>(null);
  const [key, setKey] = useState<KeyStatus | null>(null);
  const [credits, setCredits] = useState<LlmCredits | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [baseURL, setBaseURL] = useState("");

  const activeId = settings?.llm.activeProvider ?? "";
  const provider = providers.find((p) => p.id === activeId);

  const loadCredits = useCallback(
    async (id: string) => {
      setCredits(null);
      const c = await llm.credits(id);
      setCredits(c);
    },
    [llm],
  );

  const load = useCallback(async () => {
    const s = await llm.reloadSettings();
    const id = s.llm.activeProvider;
    setSettings(s);
    setProviders(await llm.listProviders());
    const p = await llm.providerSettings(id);
    setPs(p);
    setBaseURL(typeof p?.baseURL === "string" ? p.baseURL : "");
    let k: KeyStatus | null = null;
    try {
      k = await keyStatus(id);
    } catch {
      k = null;
    }
    setKey(k);
    if (k?.configured && id !== "openai-compatible") void loadCredits(id);
    else setCredits(null);
  }, [llm, loadCredits]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function update(fn: (s: GlobalSettings) => void) {
    if (!settings) return;
    const next = structuredClone(settings);
    fn(next);
    setError(null);
    try {
      await llm.saveSettings(next);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const entry = (s: GlobalSettings) => (s.llm.providers[activeId] ??= {});

  async function refreshModels() {
    setRefreshing(true);
    setError(null);
    const r = await llm.refreshModels(activeId);
    setRefreshing(false);
    if (isLlmError(r)) setError(`刷新模型信息失败：${llmErrorText(r)}`);
    else await load();
  }

  const noBridge = getBridgeState() === "missing";

  return (
    <div className="settings" role="dialog" aria-modal="true" aria-labelledby="settings-title">
      <header className="settings-head">
        <h1 id="settings-title" className="settings-title">
          设置
        </h1>
        <button className="rc-iconbtn" aria-label="关闭设置" title="关闭（Esc）" onClick={onClose}>
          <Icon name="close" size={20} />
        </button>
      </header>

      <section className="st-section" aria-labelledby="st-ai">
        <h2 id="st-ai" className="st-section-title">
          AI 模型
        </h2>
        {noBridge && (
          <p className="st-banner" role="status">
            {NO_BRIDGE_TEXT}。阅读和批注不受影响。
          </p>
        )}
        {error && (
          <p className="st-error" role="alert">
            {error}
          </p>
        )}

        <div className="st-field">
          <label className="st-label" htmlFor="st-provider">
            服务商
          </label>
          <select
            id="st-provider"
            className="st-select"
            value={activeId}
            disabled={!settings}
            onChange={(e) => {
              const v = e.target.value;
              void update((s) => {
                s.llm.activeProvider = v;
              });
            }}
          >
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          {activeId === "vercel-gateway" && <p className="st-help">默认使用 DeepSeek 模型；一个密钥可用网关上的所有模型。</p>}
        </div>

        {provider && <KeyField key={provider.id} provider={provider} status={key} onChange={setKey} />}

        {activeId === "openai-compatible" && (
          <div className="st-field">
            <label className="st-label" htmlFor="st-baseurl">
              服务地址（base URL）
            </label>
            <div className="st-row">
              <input
                id="st-baseurl"
                className="st-input"
                spellCheck={false}
                placeholder="http://localhost:11434/v1"
                value={baseURL}
                onChange={(e) => setBaseURL(e.target.value)}
              />
              <button
                className="btn"
                disabled={!/^https?:\/\/\S+$/.test(baseURL.trim())}
                onClick={() =>
                  void update((s) => {
                    entry(s).baseURL = baseURL.trim().replace(/\/+$/, "");
                  })
                }
              >
                保存
              </button>
            </div>
            <p className="st-help">OpenAI、OpenRouter、Ollama 等兼容 /chat/completions 的服务。地址只存在本机设置里。</p>
          </div>
        )}

        <div className="st-field">
          <div className="st-label-row">
            <span className="st-label">模型别名</span>
            <button className="btn btn-sm" disabled={refreshing || !settings} onClick={() => void refreshModels()}>
              {refreshing ? "刷新中…" : "刷新模型信息"}
            </button>
          </div>
          <p className="st-help">动作只写别名，这里决定每个别名用哪个模型。</p>
          {ps &&
            ALIASES.map((a) => (
              <AliasRow
                key={`${activeId}-${a.alias}`}
                providerId={activeId}
                alias={a.alias}
                label={a.label}
                ps={ps}
                onSave={(b) =>
                  void update((s) => {
                    const e = entry(s);
                    e.aliases = { ...(e.aliases ?? {}), [a.alias]: b };
                  })
                }
              />
            ))}
        </div>

        {credits && (
          <div className="st-field">
            <span className="st-label">余额</span>
            <p className="st-value">
              {credits.balance} {credits.currency ?? ""}
              {credits.totalUsed !== null && <span className="st-help"> · 已用 {credits.totalUsed}</span>}
            </p>
          </div>
        )}

        <div className="st-field">
          <span className="st-label">连接测试</span>
          {activeId && <AiTest key={activeId} llm={llm} providerId={activeId} onSuccess={() => void loadCredits(activeId)} />}
        </div>
      </section>
    </div>
  );
}
