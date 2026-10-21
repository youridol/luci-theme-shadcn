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
  // Official border/input carry their own alpha in the literal:
  // oklch(1 0 0 / 10%) and oklch(1 0 0 / 15%). They are NOT solid colors
  // re-based through the alpha ladder.
  //
  // The ring is the official 0.556 raised to 0.60. A focus indicator has to
  // clear WCAG 1.4.11's 3:1 against every surface it can land on, and 0.556
  // measured 2.68:1 on `--accent` (the hover surface every button sits on while
  // it is being clicked). 0.60 is the one value that clears 3:1 on all five
  // beds this theme paints: canvas 5.01, card 4.54, muted 3.83, accent 3.21,
  // primary (the white button) 3.13.
  ring: ["const", "oklch(0.60 0 0)"],
  // WCAG 1.4.11 wants a form control's boundary at >= 3:1 against what sits
  // behind it. The official 15% white measures 1.57:1 on a card — the field
  // edge is effectively invisible, so every input in this theme read as a
  // floating slab of tint with no outline. 35% white measures 3.23:1 on a card
  // and 3.14:1 on the canvas, so the edge survives both beds.
  input: ["const", "oklch(1 0 0 / 35%)"],
  // The fill an official input actually paints: `dark:bg-input/30` on the
  // official dark `--input` (oklch(1 0 0 / 15%)) composites to 4.5% white, not
  // 30% white. The alpha ladder cannot express that — it replaces a literal's
  // alpha instead of compositing it — so `--input-a30` came out as 30% white
  // and every field rendered as a light grey slab. This token is that composite,
  // stated directly.
  //
  // It stays clear of the text: 4.5% white over a card is 5.93:1 for
  // muted-foreground and 13.9:1 for foreground, so a field's fill never fights
  // its own placeholder. (A 30% fill measured 2.61:1 for muted-foreground,
  // below AA.)
  input_fill: ["const", "oklch(1 0 0 / 0.045)"],
  // Official `--card-foreground` / `--popover-foreground`. Both equal `--text`
  // here, but the names exist so a component can say "text on a popover"
  // instead of borrowing the page foreground.
  card_foreground: ["const", "var:text"],
  popover_foreground: ["const", "var:text"],
  sidebar: ["const", "var:surface"],
  sidebar_bg: ["const", "var:surface"],
  sidebar_foreground: ["const", "var:text"],
  sidebar_accent_foreground: ["const", "var:text"],
  sidebar_primary: ["const", "var:brand"],
  sidebar_primary_foreground: ["const", "var:on_brand"],
  login_path_stroke: ["const", "var:brand"],
  progress_bar_end: ["const", "var:brand"],
  // Fixed foreground literals. Each one is the text colour that actually passes
  // WCAG AA on its own solid fill (scripts/check-token-contrast.js asserts it):
  //   destructive 0.704 light -> near-white  9.6:1
  //   success     0.637 mid   -> near-black  6.2:1
  //   info        0.700 mid   -> near-black  7.5:1
  //   warning     0.800 light -> near-black 10.5:1
  // success/info shipped near-white text (3.0:1 and 2.5:1) until 2026-10, which
  // failed AA on every success/info tooltip and UCI-diff row.
  destructive_fg: ["const", "oklch(0.985 0 0)"],
  success_fg: ["const", "var:bg"],
  info_fg: ["const", "var:bg"],
  warning_fg: ["const", "var:bg"],
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
  // Focus indicators are stated at full alpha, not 50%: a 50%-alpha ring over
  // the canvas measures 1.87:1 and WCAG 1.4.11 asks for 3:1. `ring-a50` stays
  // as the decorative hover border (a card edge lighting up is not a focus
  // indicator and does not have to clear 3:1).
  focus_ring: ["const", "var:ring"],
  accent_foreground: ["const", "var:text"],
};

// muted_foreground / sidebar_muted: the value is 0.708, which is AA on the
// 0.145 canvas this theme ships (.dev/docs/adr/0002-dark-only.md).
const MUTED_FG = ["const", "oklch(0.708 0 0)"];

// `accent` is the hover/selected surface. It used to be the same literal as
// `secondary` and `muted` (all oklch(0.269 0 0)), so `hover:bg-accent` on a
// `bg-secondary` button or a `bg-muted` row changed nothing: the state was
// invisible across buttons, table rows, menu rows and the sidebar. The official
// dark theme splits them (secondary/muted 0.269, accent 0.371); this theme
// keeps its own 0.32 step so `--muted-foreground` text on the hover surface
// still clears AA at 4.89:1 (the official 0.371 measures 4.01:1, below AA).
const ACCENT = ["const", "oklch(0.32 0 0)"];
// The sidebar needs its own hover step: its resting surface is `--surface`
// (0.205), so the same 0.32 reads as one clear step above the rail.
const SIDEBAR_ACCENT = ["const", "oklch(0.32 0 0)"];

// Solid semantic fills. A filled badge/tooltip/button pairs a fill with a text
// colour that passes AA on it, so these are stated as pairs and asserted by
// scripts/check-token-contrast.js:
//   destructive 0.704 (official) + near-white   9.6:1
//   success     0.637            + near-black   6.2:1
//   info        0.700            + near-black   7.5:1
//   warning     0.800            + near-black  10.5:1
// `destructive_strong` is the destructive fill at a lightness that lets
// near-white text clear AA (official dark uses `bg-destructive/60`, which is
// the same idea; this states the resulting colour instead of leaning on alpha
// compositing that depends on whatever sits behind it).
const DESTRUCTIVE_STRONG = ["const", "oklch(0.56 0.191 22.216)"];

export const DERIVATIONS = {
  dark: {
    ...common,
    muted_foreground: MUTED_FG,
    sidebar_muted: MUTED_FG,
    muted: ["const", "oklch(0.269 0 0)"],
    secondary: ["const", "oklch(0.269 0 0)"],
    accent: ACCENT,
    border: ["const", "oklch(1 0 0 / 10%)"],
    panel_border: ["const", "oklch(1 0 0 / 10%)"],
    primary_hover: ["shade", "brand", -0.1],
    sidebar_accent: SIDEBAR_ACCENT,
    sidebar_active_bg: SIDEBAR_ACCENT,
    sidebar_active_fg: ["const", "var:text"],
    sidebar_border: ["const", "oklch(1 0 0 / 10%)"],
    terminal_bg: ["const", "oklch(0.12 0.02 264)"],
    warning_soft_fg: ["const", "oklch(0.86 0.10 85)"],
    progress_bar_start: ["const", "var:brand"],
    login_left_bg: ["const", "oklch(0.205 0 0)"],
    destructive_strong: DESTRUCTIVE_STRONG,
  },
};

// Baked-alpha variants. Each base (resolved once, since this theme ships a
// single colour scheme) is emitted at each alpha as a flat oklch(L C H / a)
// literal -> replaces Tailwind /NN opacity modifiers. Official values carry
// their own alpha in the literal (border oklch(1 0 0 / 10%)), so the alpha
// ladder below re-bases them.
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
  // An inactive tab's hover veil. The accent surface at 60% reads as a hint of
  // the selected state without competing with the selected trigger's own fill;
  // a baked literal, because `bg-accent/60` emits a color-mix() that
  // adr/0003 forbids (check-built-css.js enforces it).
  accent: [60],
  // No `input` entry: the field fill is `--input-fill` (the composite the
  // official `bg-input/30` actually paints). The old `--input-a30` was a 30%
  // white slab that made every input brighter than its card; nothing consumes
  // it any more, so it is not emitted.
  "label-surface": [50],
  "overlay-base": [50, 60],
  background: [60],
  ring: [50],
};
