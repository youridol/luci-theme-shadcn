/**
 * Copyright (C) 2025 eamonxg <eamonxiong@gmail.com>
 * Licensed under the Apache License, Version 2.0.
 */

// Editable input colors. Everything else is derived in spec.js.
// Values follow the official shadcn/ui dark theme (ui.shadcn.com/docs/theming):
// a neutral near-black canvas with three surface levels, near-white primary
// (white buttons on black), and no brand hue. The only deliberately kept hue
// is destructive, which matches the official value.
//
//   background 0.145 < sidebar/card/popover 0.205 < muted/accent 0.269
//   primary 0.922 + primary-foreground 0.205 (white on black)
//
// The theme ships dark only (.dev/docs/adr/0002-dark-only.md), so there is no
// `light` set to keep in step.
export const DEFAULTS = {
  dark: {
    bg: "oklch(0.145 0 0)",
    surface: "oklch(0.205 0 0)",
    text: "oklch(0.985 0 0)",
    brand: "oklch(0.922 0 0)",
    on_brand: "oklch(0.205 0 0)",
    success: "oklch(0.637 0.175 147)",
    warning: "oklch(0.80 0.12 80)",
    danger: "oklch(0.704 0.191 22.216)",
    info: "oklch(0.70 0.10 250)",
    overlay_base: "oklch(0 0 0)",
  },
};
