# Changelog

All notable changes to `luci-theme-shadcn`. Versions follow the `Makefile`'s
`PKG_VERSION`; the `.ipk` release suffix is `PKG_RELEASE`.

## 0.9.0 — unreleased

The Overview page becomes an operations dashboard, and the shell is realigned
to the admin layout it is modelled on.

### Added

- **Overview dashboard** (`admin/status/overview`). Six metric tiles (WAN
  status, online terminals, connection count, today's traffic, live rate,
  temperature), then three sections: lines (per-interface rate and state),
  resources (CPU with per-core bars, memory and storage, system info), and
  traffic (per-port sparklines, hourly bars, top hosts, protocol split). Native
  sections are hidden but reachable through an escape hatch. Fast path polls at
  5 s (1–60 s selectable), slow path at 60 s.
- **Anomaly banner** with three tiers, judged in the backend against raw
  numerators — connections, memory, temperature, load, and the share of
  hardware-offloaded connections. Every row states the threshold it crossed.
- **One-click diagnostics**: gateway, DNS, and internet reachability plus the
  verdict, on demand rather than polled.
- **Dashboard Alerts settings page** (`System → Dashboard Alerts`). Thresholds
  live in `/etc/config/shadcn-dashboard`; the form shows each built-in default
  as the placeholder and removes an option when a field is cleared, so a future
  default change still reaches installs that never configured anything. If the
  config file is absent, the page explains that and offers to recreate it —
  UCI cannot create a missing config, so the backend gained
  `shadcn.createConfig`.
- **Sampler** (`/etc/init.d/shadcn-dashboard`, procd, nice 19). Keeps 1440
  one-minute points in tmpfs for the look-back charts.
- `shadcn.board()`: hostname, firmware, kernel, target, architecture and CPU
  model, read once and cached. Surfaced on the dashboard as the 系统信息 card.
- **Uptime** in the fast sample, shown as 运行时长 — the first thing to check
  when deciding whether a reboot just happened.

### Changed

- **The desktop sidebar now rests collapsed and expands on hover.** It opens
  when the pointer enters the rail and collapses when it leaves, so glancing at
  the menu no longer costs a click. Hover expansion is `position: absolute` over
  the content rather than in flow: in flow, every sweep of the pointer resized
  `#main-wrapper` and reflowed the whole page. Clicking the toggle _pins_ it
  open instead (stored in `shadcn.sidebar.pinned`); hovering is transient and is
  never persisted, so a reload does not depend on where the pointer last sat.
  The old `shadcn.sidebar` key held the opposite meaning and is not migrated.
  Two attributes carry the state: `#sidebar[data-collapsed]` for whether the
  content is laid out, and `html[data-sidebar-floating]` for whether it is out
  of flow — the second has to live on `<html>` because that is what the
  selector matches.
- **The hover-expanded sidebar no longer collapses out from under its sub-menu.**
  The sub-drawer sits flush against the sidebar's right edge but does not overlap
  it, so moving the pointer from a menu row into the drawer always fires a
  `pointerleave` first. Collapsing on that event left the drawer floating beside
  a 48 px icon rail, and it then closed itself — the sub-items were unreachable.
  Leaving now starts a 120 ms grace timer, and the collapse is skipped when the
  pointer's coordinates land inside the drawer or the collapsed-popover rect.
  Coordinates rather than `:hover`, because hover state has not landed yet one
  frame after the pointer crosses. Leaving the drawer schedules the collapse
  again, so it cannot hang open. Picking a sub-item closes both surfaces via
  `collapseAfterNavigate()`, which deliberately leaves `pinned` alone.
- **Every dashboard chart was redrawn** (`.dev/docs/adr/0008-chart-motion-and-flat-bars.md`).
  Lines are monotone-cubic curves with a "now" endpoint marker instead of
  polylines; bars have a rounded top and a full-height rail per slot; the
  hourly chart is flat columns with the peak lifted, replacing the isometric
  three-face bars (so `adr/0007`'s one 3D use is gone); rings are stroked arcs
  with real angular gaps, a centre reading and, for memory, a single used arc
  over a track instead of two colliding wedges; rank rows are 4px round-capped
  strokes.
- **Charts morph between samples instead of jumping.** A module-level map in
  `_charts.js` keeps the previous numbers (keyed by card, not by row index, so
  a re-ordered ranking does not tween one host's bar into another's) and tweens
  the geometry over 420 ms. A first paint still draws itself in once; the
  `dash-enter` class is removed after 700 ms so a browser that never runs the
  animation cannot leave the line invisible. `prefers-reduced-motion` writes
  the final geometry with no tween.
- **The ports card's download and upload lines now share one y-scale.** They
  were scaled independently, so upload looked as busy as download while
  carrying a sixth of the traffic. The legend carries the current readings.
- **The ports chart is a framed plot now, not a bare sparkline.** It has a
  y-axis with three labelled ticks, dashed guides, a baseline, a vertical axis
  line, a two-tick time axis (first and last sample), and an area fill that
  fades from the series colour to transparent. Series colours come from the
  semantic tokens: primary for download, `--info` for upload, `--success` and
  `--warning` for a third and fourth series.
- **Area fills use an SVG `<linearGradient>`** (`.dev/docs/adr/0009-svg-area-gradient.md`).
  `adr/0003` bans CSS gradients and `scripts/check-built-css.js` enforces it;
  this is a paint server, not a CSS gradient function, so the check still
  passes. The colours stay in CSS: each `<stop>` is `stop-color: currentColor`
  and the gradient element carries a `dash-grad-<tone>` class. A flat fill was
  measured at 0.28 opacity against `oklch(0.205)` and was simply invisible.
- **Axis labels are HTML, not SVG `<text>`.** The frame stretches with
  `preserveAspectRatio="none"`, so on a wide card the horizontal scale is about
  twice the vertical one and glyphs came out visibly wide and squat ("238M" as
  a bold slab). Axis charts are wrapped in `.shadcn-dash-plot`; labels are
  absolutely positioned at the exact fraction where their gridline runs.
- **The y-axis rounds to binary steps** (1/2/5 × 1024ᵏ) instead of decimal
  ones. A decimal "round" maximum of 1e11 printed as `93.1G` through the
  1024-based formatter — the rounding bought nothing.
- The protocol legend gained a colour dot per row plus its share, and the ring
  centre shows the total.
- **Root font size is 16px**, with body copy at 14px (was 14px root
  throughout). Every shell dimension is expressed in rem, so the old root made
  the whole chrome 12.5% smaller than the reference layout: a `16rem` sidebar
  measured 224px instead of 256px, the `h-16` header 49px instead of 64px. The
  sidebar, both headers, card radius and content inset now match the reference;
  text density is unchanged.
- **Content is capped at 80rem and centred** (`max-w-7xl`), so a wide window no
  longer stretches every reading line to the full width. Applied to
  `#maincontent`'s children, not the scroll container, so the scrollbar stays
  at the window edge.
- Sidebar and card headers are 64px (was 49 / 42px).

### Removed

- **The light colour scheme.** `data-darkmode="true"` is set unconditionally
  before paint and `shadcn.theme` is deleted from localStorage rather than
  read, so a browser that once chose light lands on dark with no flash.
- **All gradients**, including the token helpers that produced them. One
  exception was later carved out for chart area fills: an SVG paint server
  whose colours come from CSS (`adr/0009`). CSS gradient functions stay banned.
- `<img>`-based icons on the shell: every icon is a mask box tinted with
  `currentColor`, so one asset serves every tone.

### Fixed

- Integer division silently zeroed the percentage of conntrack, memory and
  storage use, so those alerts could never fire.
- `caps` did not report the CPU count, which made the load alert unreachable.
- Hourly traffic chart drew two oversized bars before a full day of samples;
  it now uses a fixed 24-slot axis with gaps for empty hours.
- DNS diagnostics read the resolver's own `Address:` line as the answer.
- The internet reachability probe used a resolver that is dropped on some
  lines, reporting "no internet" on a healthy connection.
- Rank-row host links sat in the middle of their cell: the theme's global
  `button` rule centres its content with `display: inline-flex`, which
  `text-align: left` cannot undo. The dashboard now resets
  `justify-content` on those buttons.
- The sparkline endpoint marker rendered as a 28×12 ellipse: the chart's
  `preserveAspectRatio="none"` squashes a `<circle>`. It is now a zero-length
  stroke with a round cap and `non-scaling-stroke`.
- `main.css` carried four utilities nothing uses (`.transform`, `.filter`,
  `.scheme-light`, `.bg-popover`) plus the `--tw-rotate-*` / `--tw-drop-shadow-*`
  property blocks they register. Tailwind's `@source not "../../docs/*.md"`
  only excluded the top level, so a code span in an ADR (`transform: scaleY()`)
  was being compiled into the shipped stylesheet. The exclusion now covers
  `docs/**/*.md`, and main.css drops ~1.3 KB.
- **`table-sort` no longer throws `factory yields invalid constructor`.** The
  module ended with `return function tableSort() {}` — a plain function. LuCI
  gates every `L.require()` result on `Class.isSubclass(v)`, i.e.
  `typeof v === 'function' && v.prototype instanceof Class`, so a bare function
  fails the check and the TypeError aborts the rest of that page's scripts. It
  now returns `baseclass.extend({ __init__() { … } })`, matching
  `sidebar-shadcn.js` and `router-shadcn.js`. The contract is easy to get
  backwards: `require()` itself does `new _class()`, so the return value must be
  the **class**, and `__init__` is where the work belongs.

### Notes

- `ucode` on this build has no `for…of`, no `Math`, no `isNaN`, and its regex
  rejects the `m` flag and `(?:…)` non-capturing groups — the latter fails
  loudly enough to take down every backend method. See
  [.dev/docs/dashboard.md](.dev/docs/dashboard.md) for the full list.
- Budgets in `.dev/tests/build-output.test.js` guard asset growth; they were
  re-based after the dark-only work removed a colour scheme's worth of bytes.

## 0.8.0

- Sidebar layout realignment (v0.7.0 line) concluded: floating inset sidebar,
  grouped navigation, collapsible to icons.
- Client-side router between LuCI view pages, with a full-load fallback.
- On-demand per-page patches for third-party pages.

## 0.7.0

- Reworked the shell around shadcn/ui design language; sidebar replaces the
  horizontal menu.
