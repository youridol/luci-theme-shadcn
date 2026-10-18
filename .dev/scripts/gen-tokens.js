/**
 * Copyright (C) 2025 eamonxg <eamonxiong@gmail.com>
 * Licensed under the Apache License, Version 2.0.
 */

import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { alpha, toOklch } from "@eamonxg/luci-theme-tokens/engine";
import { block, themeColors } from "@eamonxg/luci-theme-tokens/emit";
import { resolveMode } from "../tokens/resolve.js";
import { ALPHAS } from "../tokens/spec.js";

const snake = (s) => s.replace(/-/g, "_");
const withAlpha = (oklchStr, pct) => toOklch(alpha(oklchStr, pct / 100));

function alphaTokens(resolved) {
  const out = {};
  for (const [base, list] of Object.entries(ALPHAS)) {
    const val = resolved[snake(base)];
    if (val === undefined) throw new Error(`ALPHAS base not resolved: ${base}`);
    for (const a of list) out[`${base}-a${a}`] = withAlpha(val, a);
  }
  return out;
}

const dark = resolveMode("dark");
const darkA = alphaTokens(dark);

const STRUCTURE = `
  --font-sans: "Inter Variable", ui-sans-serif, system-ui, sans-serif;
  --font-mono: ui-monospace, "SF Mono", Menlo, Monaco, Consolas, monospace;

  /* Elevation. Emitted on :root (not just inlined into the shadow-* utilities)
     so on-demand patches/*.css -- standalone entries that carry no Tailwind
     helper output -- can reach it as var(--shadow-sm). */
  --shadow-sm:
    0 1px 3px 0 oklch(0% 0 0 / 0.1), 0 1px 2px -1px oklch(0% 0 0 / 0.1);
`;

const themeColorsCss = themeColors([
  ...Object.keys(dark),
  ...Object.keys(darkA),
]);

// Add aliases for backward compatibility
const aliases = [
  `  --color-sidebar-fg: var(--sidebar-foreground);`,
  `  --color-sidebar-accent-fg: var(--sidebar-accent-foreground);`,
  `  --color-terminal-fg: var(--terminal-foreground);`,
].join("\n");

const THEME = `@theme inline {
${themeColorsCss}

${aliases}

  --font-sans: var(--font-sans);
  --font-mono: var(--font-mono);

  --shadow-sm: var(--shadow-sm);

  /* Radius ladder. The official theme defines --radius: 0.625rem and derives
     every step from it (sm 0.6x, md 0.8x, lg 1x, xl 1.4x, 2xl 1.8x), so
     rounded-md is 8px and rounded-xl is 14px. --radius-base stays as the
     single knob for the rest of the theme, set to the official --radius. */
  --radius: 0.625rem;
  --radius-base: var(--radius);
  --radius-sm: calc(var(--radius) * 0.6);
  --radius-md: calc(var(--radius) * 0.8);
  --radius-lg: var(--radius);
  --radius-xl: calc(var(--radius) * 1.4);
  --radius-2xl: calc(var(--radius) * 1.8);
}
`;

const HEADER = `/**
 * luci-theme-shadcn: design tokens -- GENERATED, DO NOT EDIT.
 * Run \`pnpm gen:tokens\`. Source: tokens/defaults.js + tokens/spec.js
 * All color values are flat oklch() literals; no dynamic color functions.
 * This theme ships dark only (.dev/docs/adr/0002-dark-only.md): the values
 * live on :root and there is no mode-override block.
 */
`;

const css =
  HEADER + "\n" + block(":root", dark, darkA) + STRUCTURE + "}\n\n" + THEME;

await writeFile(
  resolve(import.meta.dirname, "../src/media/_tokens.css"),
  css,
  "utf-8",
);
console.log("gen-tokens: wrote src/media/_tokens.css");
