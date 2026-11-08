/**
 * 首次启动引导（设计文档「边界情况」：首次启动没有 API Key）：欢迎 → 选择服务商 → 填写密钥 → 一键测试。
 * 每一步都能跳过；阅读和批注不需要 AI。已经有密钥（如环境变量）时不显示，直接记为 done。
 */
import { useEffect, useState } from "react";
import type { GlobalSettings, LlmProviderInfo, LlmService, OnboardingStatus } from "@reader/core";
import { AiTest, KeyField } from "./Settings";
import { type KeyStatus, getBridgeState, keyStatus } from "./llm";

const STEPS = ["欢迎", "选择服务商", "填写密钥", "一键测试"];

const PROVIDER_NOTE: Record<string, string> = {
  "vercel-gateway": "默认使用 DeepSeek，一个密钥可用多家模型",
  deepseek: "DeepSeek 官方 API",
  "openai-compatible": "OpenAI、OpenRouter、本地 Ollama 等，自填服务地址",
};

async function setStatus(llm: LlmService, status: OnboardingStatus) {
  const s = await llm.getSettings();
  s.onboarding = { ...s.onboarding, status, updatedAt: new Date().toISOString() };
  await llm.saveSettings(s);
}

/**
 * 决定要不要显示引导：status 为 pending，且当前服务商没有密钥。
 * 有密钥时静默记为 done；没有 bridge（生产构建）时不显示。
 */
export async function shouldShowOnboarding(llm: LlmService): Promise<boolean> {
  const s = await llm.getSettings();
  if (s.onboarding.status !== "pending" || getBridgeState() === "missing") return false;
  let k: KeyStatus;
  try {
    k = await keyStatus(s.llm.activeProvider);
  } catch {
    return false;
  }
  if (k.configured) {
    await setStatus(llm, "done");
    return false;
  }
  return true;
}

export function Onboarding({ llm, onClose }: { llm: LlmService; onClose: () => void }) {
  const [step, setStep] = useState(0);
  const [settings, setSettings] = useState<GlobalSettings | null>(null);
  const [providers, setProviders] = useState<LlmProviderInfo[]>([]);
  const [key, setKey] = useState<KeyStatus | null>(null);
  const [baseURL, setBaseURL] = useState("");
  const [tested, setTested] = useState(false);

  const activeId = settings?.llm.activeProvider ?? "";
  const provider = providers.find((p) => p.id === activeId);

  useEffect(() => {
    void (async () => {
      setSettings(await llm.getSettings());
      setProviders(await llm.listProviders());
    })();
  }, [llm]);

  useEffect(() => {
    if (!activeId) return;
    setKey(null);
    void keyStatus(activeId).then(setKey, () => setKey(null));
    void llm.providerSettings(activeId).then((p) => setBaseURL(typeof p?.baseURL === "string" ? p.baseURL : ""));
  }, [activeId, llm]);

  async function finish(status: OnboardingStatus) {
    await setStatus(llm, status);
    onClose();
  }

  async function chooseProvider(id: string) {
    const s = await llm.getSettings();
    s.llm.activeProvider = id;
    await llm.saveSettings(s);
    setSettings(await llm.getSettings());
  }

  async function saveBaseURL() {
    const s = await llm.getSettings();
    const e = (s.llm.providers[activeId] ??= {});
    e.baseURL = baseURL.trim().replace(/\/+$/, "");
    await llm.saveSettings(s);
  }

  const canNextFromKey = Boolean(key?.configured || (provider && !provider.requiresKey));

  return (
    <div className="ob-scrim">
      <div className="ob" role="dialog" aria-modal="true" aria-labelledby="ob-title">
        <ol className="ob-steps" aria-label="步骤">
          {STEPS.map((s, i) => (
            <li key={s} aria-current={i === step ? "step" : undefined} data-done={i < step || undefined}>
              {s}
            </li>
          ))}
        </ol>

        {step === 0 && (
          <>
            <h2 id="ob-title" className="ob-title">
              欢迎使用 Glossa
            </h2>
            <p className="ob-lead">AI 解释、提问需要一个模型服务。阅读和批注不需要，随时可以跳过。</p>
          </>
        )}

        {step === 1 && (
          <>
            <h2 id="ob-title" className="ob-title">
              选择服务商
            </h2>
            <div className="ob-cards" role="radiogroup" aria-label="服务商">
              {providers.map((p) => (
                <button
                  key={p.id}
                  className="ob-card"
                  role="radio"
                  aria-checked={p.id === activeId}
                  onClick={() => void chooseProvider(p.id)}
                >
                  <span className="ob-card-name">{p.name}</span>
                  <span className="ob-card-note">{PROVIDER_NOTE[p.id] ?? ""}</span>
                </button>
              ))}
            </div>
          </>
        )}

        {step === 2 && provider && (
          <>
            <h2 id="ob-title" className="ob-title">
              填写密钥
            </h2>
            {provider.id === "openai-compatible" && (
              <div className="st-field">
                <label className="st-label" htmlFor="ob-baseurl">
                  服务地址（base URL）
                </label>
                <div className="st-row">
                  <input id="ob-baseurl" className="st-input" spellCheck={false} value={baseURL} onChange={(e) => setBaseURL(e.target.value)} />
                  <button className="btn" disabled={!/^https?:\/\/\S+$/.test(baseURL.trim())} onClick={() => void saveBaseURL()}>
                    保存
                  </button>
                </div>
              </div>
            )}
            <KeyField key={provider.id} provider={provider} status={key} onChange={setKey} />
            {provider.keyEnvVar && (
              <p className="st-help">
                开发时也可以写在仓库根目录的 .env.local：<code>{provider.keyEnvVar}=…</code>
              </p>
            )}
          </>
        )}

        {step === 3 && (
          <>
            <h2 id="ob-title" className="ob-title">
              一键测试
            </h2>
            <p className="ob-lead">发一句固定的话，确认密钥和模型能用。</p>
            <AiTest llm={llm} providerId={activeId} onSuccess={() => setTested(true)} />
          </>
        )}

        <div className="ob-actions">
          <button className="btn btn-ghost" onClick={() => void finish("skipped")}>
            跳过
          </button>
          <span className="ob-spacer" />
          {step > 0 && (
            <button className="btn" onClick={() => setStep(step - 1)}>
              上一步
            </button>
          )}
          {step < 3 ? (
            <button className="btn btn-primary" disabled={(step === 1 && !activeId) || (step === 2 && !canNextFromKey)} onClick={() => setStep(step + 1)}>
              下一步
            </button>
          ) : (
            <button className={tested ? "btn btn-primary" : "btn"} onClick={() => void finish("done")}>
              完成
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
