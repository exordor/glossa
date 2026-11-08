import { useEffect, useState } from "react";
import type { Vault } from "@reader/core";
import { sampleBookVault } from "./sample-book";
import { FsAccessVault, ensurePermission, fsAccessSupported, lastFolder, pickFolder, rememberFolder } from "./vault-fsaccess";

/** 首次打开：选一个书文件夹（一章一个 .md），或先看示例书。 */
export function Start({ onOpen }: { onOpen: (vault: Vault, name: string, persistent: boolean) => Promise<void> }) {
  const [last, setLast] = useState<FileSystemDirectoryHandle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const supported = fsAccessSupported();

  useEffect(() => {
    void lastFolder().then(setLast);
  }, []);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      if ((e as DOMException).name !== "AbortError") setError(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  }

  const openHandle = async (h: FileSystemDirectoryHandle) => {
    if (!(await ensurePermission(h))) throw new Error("没有获得这个文件夹的读写权限");
    await rememberFolder(h);
    await onOpen(new FsAccessVault(h), h.name, true);
  };

  return (
    <div className="start">
      <h1 className="start-title">Glossa</h1>
      <p className="start-lead">选一个书文件夹开始读。文件夹里一章一个 .md，按文件名排序；画布和批注存在它里面的 .canvas/ 目录，原文件不会被修改。</p>
      <div className="start-actions">
        {last && (
          <button className="btn btn-primary" disabled={busy} onClick={() => void run(() => openHandle(last))}>
            继续读「{last.name}」
          </button>
        )}
        <button
          className={last ? "btn" : "btn btn-primary"}
          disabled={busy || !supported}
          onClick={() => void run(async () => openHandle(await pickFolder()))}
        >
          打开书文件夹…
        </button>
        <button className="btn" disabled={busy} onClick={() => void run(async () => onOpen(await sampleBookVault(), "示例书", false))}>
          打开示例书
        </button>
      </div>
      {!supported && <p className="start-note">当前浏览器不支持打开本地文件夹，请用 Chrome 或 Edge。</p>}
      {error && <p className="start-error" role="alert">{error}</p>}
    </div>
  );
}
