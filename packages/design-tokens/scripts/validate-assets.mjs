import { readFile } from "node:fs/promises";

const tokens = JSON.parse(await readFile(new URL("../src/tokens.json", import.meta.url), "utf8"));
const css = await readFile(new URL("../src/tokens.css", import.meta.url), "utf8");

if (typeof tokens !== "object" || tokens === null || Array.isArray(tokens)) {
  throw new TypeError("Design tokens must be a JSON object");
}

const cssVariables = [...css.matchAll(/--([a-z0-9-]+)\s*:/g)].map((match) => match[1]);
if (cssVariables.length === 0) {
  throw new TypeError("Design-token CSS must declare custom properties");
}

const declared = new Set(cssVariables);
for (const match of css.matchAll(/var\(--([a-z0-9-]+)\)/g)) {
  if (!declared.has(match[1])) {
    throw new TypeError(`Design-token CSS references undeclared property --${match[1]}`);
  }
}
