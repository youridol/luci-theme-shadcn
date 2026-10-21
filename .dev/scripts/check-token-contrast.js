/**
 * Copyright (C) 2025 eamonxg <eamonxiong@gmail.com>
 * Licensed under the Apache License, Version 2.0.
 */

import Color from "colorjs.io";
import { resolveMode } from "../tokens/resolve.js";

// The theme ships dark only (.dev/docs/adr/0002-dark-only.md), so there is one
// set to check rather than one per mode.
const MIN_TEXT_CONTRAST = 4.5;
// WCAG 1.4.11 (non-text contrast): focus indicators and form-control edges.
const MIN_UI_CONTRAST = 3;

/* colorjs.io's contrast() ignores the alpha channel, so a translucent colour
   measured as if it were opaque. Two bugs came from that:

   - the 50%-alpha focus ring reported a comfortable 4.18:1 while it actually
     painted 1.87:1 over the canvas — the check passed and the ring was
     invisible;
   - a translucent *background* was compared directly against opaque text, so
     near-white text on a 4.5%-white fill reported 1.04:1 (it had been compared
     to the fill's uncomposited near-white).

   Both are fixed by compositing in the right direction: the background is
   painted over the bed it sits on, then the (opaque) text is measured against
   that result. */
function composite(fill, bed) {
  const fg = new Color(fill).to("srgb");
  const base = new Color(bed).to("srgb");
  const alpha = fg.alpha ?? 1;
  if (alpha >= 1) return fg;
  const out = fg.clone();
  for (let i = 0; i < 3; i++)
    out.coords[i] = fg.coords[i] * alpha + base.coords[i] * (1 - alpha);
  out.alpha = 1;
  return out;
}

// Text on a surface. `bed` is what the surface is painted over when the
// surface itself carries alpha (the page canvas is the default).
const textContrast = (foreground, background, bed = "background", tokens) =>
  Color.contrast(
    composite(tokens[foreground], tokens[background]),
    composite(tokens[background], tokens[bed]),
    "WCAG21",
  );

const failures = [];
const tokens = resolveMode("dark");

// [foreground, background] pairs whose text must clear AA. Every solid
// semantic fill is checked against the text colour it is paired with, because
// that pairing is the thing that fails when a token changes: success and info
// shipped near-white text on mid-lightness fills (3.0:1 and 2.5:1) until the
// 2026-10 realignment.
const textChecks = [
  ["muted_foreground", "background"],
  ["muted_foreground", "card"],
  ["muted_foreground", "accent"],
  ["sidebar_muted", "sidebar_bg"],
  ["sidebar_muted", "sidebar_accent"],
  ["foreground", "background"],
  ["foreground", "card"],
  ["foreground", "accent"],
  ["foreground", "muted"],
  ["primary_foreground", "primary"],
  ["destructive_fg", "destructive_strong"],
  ["success_fg", "success"],
  ["info_fg", "info"],
  ["warning_fg", "warning"],
  ["terminal_foreground", "terminal_bg"],
];

// Field text sits on `input_fill`, which is translucent over a card.
const fieldChecks = [
  ["foreground", "input_fill", "card"],
  ["muted_foreground", "input_fill", "card"],
];

// Non-text edges that carry meaning: the focus ring and the input boundary.
// The ring is checked on every surface a focused control can sit on — a ring
// that passes on the canvas but disappears on `--accent` still fails as an
// indicator.
const uiChecks = [
  ["focus_ring", "background"],
  ["focus_ring", "card"],
  ["focus_ring", "muted"],
  ["focus_ring", "accent"],
  ["focus_ring", "primary"],
  ["input", "card"],
  ["input", "background"],
];

for (const [foreground, background] of textChecks) {
  const ratio = textContrast(foreground, background, "background", tokens);
  if (ratio < MIN_TEXT_CONTRAST)
    failures.push(
      `dark: ${foreground} on ${background} is ${ratio.toFixed(2)}:1 ` +
        `(needs ${MIN_TEXT_CONTRAST}:1)`,
    );
}

for (const [foreground, background, bed] of fieldChecks) {
  const ratio = textContrast(foreground, background, bed, tokens);
  if (ratio < MIN_TEXT_CONTRAST)
    failures.push(
      `dark: ${foreground} on ${background} over ${bed} is ` +
        `${ratio.toFixed(2)}:1 (needs ${MIN_TEXT_CONTRAST}:1)`,
    );
}

for (const [foreground, background] of uiChecks) {
  const ratio = textContrast(foreground, background, "background", tokens);
  if (ratio < MIN_UI_CONTRAST)
    failures.push(
      `dark: ${foreground} on ${background} is ${ratio.toFixed(2)}:1 ` +
        `(needs ${MIN_UI_CONTRAST}:1, WCAG 1.4.11)`,
    );
}

if (failures.length > 0) {
  console.error(`Token contrast failed:\n${failures.join("\n")}`);
  process.exitCode = 1;
} else {
  console.log(
    `Token contrast passes: ${textChecks.length + fieldChecks.length} text ` +
      `pairs at >= ${MIN_TEXT_CONTRAST}:1, ${uiChecks.length} UI pairs at ` +
      `>= ${MIN_UI_CONTRAST}:1 (dark).`,
  );
}
