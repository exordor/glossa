import { useCallback, useEffect, useState } from "react";
import type { Vault } from "@reader/core";
import { BookView } from "./BookView";
import { Onboarding, shouldShowOnboarding } from "./Onboarding";
import { Settings } from "./Settings";
import { Start } from "./Start";
import { appLlm } from "./llm";
import { type BookSession, openBook } from "./session";

export function App() {
  const [session, setSession] = useState<BookSession | null>(null);
  /** 设置页盖在当前视图上：书保持挂载，正在生成的回答不中断。 */
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [onboarding, setOnboarding] = useState(false);

  useEffect(() => {
    void shouldShowOnboarding(appLlm.llm).then(setOnboarding, () => setOnboarding(false));
  }, []);

  async function handleOpen(vault: Vault, name: string, persistent: boolean) {
    setSession(await openBook(vault, name, persistent));
  }

  const openSettings = useCallback(() => setSettingsOpen(true), []);
  const closeSettings = useCallback(() => {
    setSettingsOpen(false);
    // 应用级 LLM 和书里的 reader.llm 各缓存一份设置：关设置页时都重新读一次。
    void appLlm.llm.reloadSettings();
    void session?.reader.llm.reloadSettings();
  }, [session]);

  const llm = session?.reader.llm ?? appLlm.llm;

  return (
    <>
      {session ? (
        <BookView key={session.book.id} session={session} onClose={() => setSession(null)} onOpenSettings={openSettings} />
      ) : (
        <Start onOpen={handleOpen} onOpenSettings={openSettings} />
      )}
      {settingsOpen && <Settings llm={llm} onClose={closeSettings} />}
      {onboarding && !session && !settingsOpen && <Onboarding llm={appLlm.llm} onClose={() => setOnboarding(false)} />}
    </>
  );
}
