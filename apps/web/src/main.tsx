import "@reader/theme/tokens.css";
import "tldraw/tldraw.css";
import "katex/dist/katex.min.css";
import "./app.css";
import "./cards.css";
import "./settings.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
