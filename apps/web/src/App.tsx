import { useState } from "react";
import type { Vault } from "@reader/core";
import { BookView } from "./BookView";
import { Start } from "./Start";
import { type BookSession, openBook } from "./session";

export function App() {
  const [session, setSession] = useState<BookSession | null>(null);

  async function handleOpen(vault: Vault, name: string, persistent: boolean) {
    setSession(await openBook(vault, name, persistent));
  }

  if (!session) return <Start onOpen={handleOpen} />;
  return <BookView key={session.book.id} session={session} onClose={() => setSession(null)} />;
}
