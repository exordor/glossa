import { mkdirSync, writeFileSync } from "node:fs";
import { buildTokensCss } from "../src/css.js";

const out = new URL("../dist/tokens.css", import.meta.url);
mkdirSync(new URL("../dist/", import.meta.url), { recursive: true });
writeFileSync(out, buildTokensCss());
console.log(`wrote ${out.pathname}`);
