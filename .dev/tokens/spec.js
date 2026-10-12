/**
 * Copyright (C) 2025 eamonxg <eamonxiong@gmail.com>
 * Licensed under the Apache License, Version 2.0.
 */

// Operators: ['mix',a,b,p] ['shade',a,dl] ['set',a,L,C] ['alpha',a,p] ['const',str]
// 'const','var:x' aliases token x. All values resolve to flat oklch() literals.
//
// Names follow the official shadcn/ui theme (ui.shadcn.com/docs/theming) for
// every surface/foreground token, so the docs can be read 1:1. LuCI-specific
// surfaces (terminal, progress bar, login) keep their own names.
//
// The official three-level background ladder is expressed directly here:
//   background 0.145 < sidebar/card/popover 0.205 < muted/accent 0.269 (dark)
const common = {
  // Aliases to inputs (keep consumer names stable)
  background: ["const", "var:bg"],
  foreground: ["const", "var:text"],
  primary: ["const", "var:brand"],
  primary_foreground: ["const", "var:on_brand"],
  card: ["const", "var:surface"],
  popover: ["const", "var:surface"],
  destructive: ["const", "var:danger"],
  // Official border/input carry their own alpha in the literal: dark
  // oklch(1 0 0 / 10%) and oklch(1 0 0 / 15%), light oklch(0.922 0 0) solid.
  // They are NOT solid colors re-based through the alpha ladder.
  ring: ["const", "oklch(0.556 0 0)"],
  input: ["const", "oklch(0.922 0 0)"],
  sidebar: ["const", "var:surface"],
  sidebar_bg: ["const", "var:surface"],
  sidebar_foreground: ["const", "var:text"],
  sidebar_accent_foreground: ["const", "var:text"],
  sidebar_primary: ["const", "var:brand"],
  sidebar_primary_foreground: ["const", "var:on_brand"],
  login_path_stroke: ["const", "var:brand"],
  progress_bar_end: ["const", "var:brand"],
  // Fixed foreground literals
  destructive_fg: ["const", "oklch(0.985 0 0)"],
  success_fg: ["const", "oklch(0.985 0 0)"],
  info_fg: ["const", "oklch(0.985 0 0)"],
  warning_fg: ["const", "oklch(0.205 0 0)"],
  terminal_foreground: ["const", "oklch(0.85 0.08 155)"],
  // Row-hover veil for the always-dark log terminal (patches/admin-status-*):
  // foreground-based alphas flip with the mode and vanish on the fixed bed.
  terminal_hover: ["alpha", "terminal_foreground", 0.06],
  // Shared derived
  muted_foreground: ["const", "oklch(0.708 0 0)"],
  secondary_foreground: ["const", "var:text"],
  sidebar_muted: ["const", "oklch(0.708 0 0)"],
  // Kept for LuCI surfaces the official set has no name for.
  panel_bg: ["const", "var:surface"],
  label_surface: ["const", "var:muted"],
  focus_ring: ["alpha", "ring", 0.5],
};

// muted_foreground / sidebar_muted differ per mode: the official light value
// (0.556) is AA on white, while the official dark value (0.708) is AA on the
// 0.145 canvas. Using one value for both fails contrast in light mode.
const MUTED_FG_LIGHT = ["const", "oklch(0.556 0 0)"];
const MUTED_FG_DARK = ["const", "oklch(0.708 0 0)"];

export const DERIVATIONS = {
  light: {
    ...common,
    muted_foreground: MUTED_FG_LIGHT,
    sidebar_muted: MUTED_FG_LIGHT,
    muted: ["const", "oklch(0.97 0 0)"],
    secondary: ["const", "oklch(0.97 0 0)"],
    accent: ["const", "oklch(0.97 0 0)"],
    border: ["const", "oklch(0.922 0 0)"],
    panel_border: ["const", "oklch(0.922 0 0)"],
    primary_hover: ["shade", "brand", -0.06],
    sidebar_accent: ["const", "oklch(0.97 0 0)"],
    sidebar_active_bg: ["const", "oklch(0.97 0 0)"],
    sidebar_active_fg: ["const", "var:text"],
    sidebar_border: ["const", "oklch(0.922 0 0)"],
    terminal_bg: ["const", "oklch(0.14 0.02 264)"],
    warning_soft_fg: ["const", "oklch(0.42 0.12 75)"],
    progress_bar_start: ["const", "var:brand"],
    login_left_bg: ["const", "oklch(0.97 0 0)"],
  },
  dark: {
    ...common,
    muted_foreground: MUTED_FG_DARK,
    sidebar_muted: MUTED_FG_DARK,
    muted: ["const", "oklch(0.269 0 0)"],
    secondary: ["const", "oklch(0.269 0 0)"],
    accent: ["const", "oklch(0.269 0 0)"],
    border: ["const", "oklch(1 0 0 / 10%)"],
    input: ["const", "oklch(1 0 0 / 15%)"],
    panel_border: ["const", "oklch(1 0 0 / 10%)"],
    primary_hover: ["shade", "brand", -0.1],
    sidebar_accent: ["const", "oklch(0.269 0 0)"],
    sidebar_active_bg: ["const", "oklch(0.269 0 0)"],
    sidebar_active_fg: ["const", "var:text"],
    sidebar_border: ["const", "oklch(1 0 0 / 10%)"],
    terminal_bg: ["const", "oklch(0.12 0.02 264)"],
    warning_soft_fg: ["const", "oklch(0.86 0.10 85)"],
    progress_bar_start: ["const", "var:brand"],
    login_left_bg: ["const", "oklch(0.205 0 0)"],
  },
};

// Baked-alpha variants. Each base (resolved per mode) is emitted at each alpha
// as a flat oklch(L C H / a) literal -> replaces Tailwind /NN opacity modifiers.
// Official values carry their own alpha in the literal (border oklch(1 0 0 / 10%)),
// so the alpha ladder below re-bases them per mode.
export const ALPHAS = {
  primary: [5, 10, 15, 20, 25, 60, 70, 90],
  destructive: [8, 10, 20, 30, 40, 50, 60, 70, 80, 90],
  foreground: [5, 30],
  secondary: [80],
  muted: [30, 80],
  "muted-foreground": [70],
  success: [10, 15, 30, 40, 80],
  warning: [10, 15, 30, 40],
  info: [10, 15, 30, 40, 80],
  border: [10, 15, 60, 80],
  input: [30],
  "label-surface": [50],
  "overlay-base": [50, 60],
  background: [60],
  ring: [50],
};
