# Changelog

All notable changes to `luci-theme-shadcn`. Versions follow the `Makefile`'s
`PKG_VERSION`; the `.ipk` release suffix is `PKG_RELEASE`.

## 0.10.0 — unreleased

The content area stops being a centred column and becomes a full-bleed surface
that yields to the sidebar in two steps.

### Changed

- **The content uses every pixel the sidebar is not occupying.** The
  `max-width: 80rem` (1280px) centred column on `#maincontent`'s children is
  gone. On a wide window that cap left a narrow strip of content with dead
  canvas on both sides while the sidebar sat at the far left; now the only
  limit on the content is the sidebar itself.
- **The desktop sidebar is `position: fixed` and the content insets itself.**
  It used to be a flex item that reserved space by shrinking `#main-wrapper`.
  It is now out of flow, and `#main-wrapper` clears it with
  `padding-left: var(--sidebar-inset)`. Because that is padding on a `flex-1`
  box rather than a width on a sibling, the content still fills all remaining
  width — which is what makes removing the cap possible.
- **Avoidance is two levels, both driven by `<html>` attributes.** Level 1:
  `data-sidebar-collapsed="false"` → `--sidebar-inset: 16rem`. Level 2:
  `data-sidebar-sub="true"` → `--sidebar-inset: calc(16rem + 12rem)`, set by
  `menu-shadcn.js` while the sub-panel is open. One variable chain
  (`--sidebar-w-rail` / `--sidebar-w-full` / `--sidebar-w-sub` →
  `--sidebar-primary-w` → `--sidebar-inset`) keeps the rail width, the panel
  width and the inset from ever disagreeing.
- **The sub-panel is positioned by CSS, not measured by JS.** It was
  `panel.style.left = sidebar.getBoundingClientRect().right`, which read the
  _current_ width; opening it while the sidebar was easing from 3rem to 16rem
  pinned it to the rail's right edge and the expanded sidebar then covered it
  (measured: panel `left: 48` against a 256px sidebar). It is now
  `left: var(--sidebar-primary-w)` with a 200ms `left` transition, so it
  follows the sidebar frame by frame with no re-measure and no listener.
- **Picking a level-2 item now collapses both levels and resets.** The link
  handler calls `collapseAfterNavigate()`, which closes the sub-panel, collapses
  the primary sidebar, and **clears `shadcn.sidebar.pinned`**. Previously it
  deliberately left the pin alone; the requirement is now "clicking a level-2
  item returns everything to the default resting state", so the pin is part of
  what gets reset.

### Removed

- **`html[data-sidebar-floating]`.** It existed only to switch the hover-expanded
  sidebar to `absolute` so a pointer sweep would not reflow the page. With the
  sidebar permanently out of flow, the attribute has no meaning; hover-expand and
  click-to-pin now take the identical avoidance path.
- **The fixed 12rem `min-w-40` on the sub-panel.** It was content-sized; a fixed
  `--sidebar-w-sub` is what lets the inset be an arithmetic expression instead of
  a measurement.

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
- **Every hover state was invisible.** `--accent`, `--secondary` and `--muted`
  were all the same literal `oklch(0.269 0 0)`, so `hover:bg-accent` on a
  `bg-secondary` button, a `bg-muted` table row, a menu row or a sidebar item
  changed nothing. `--accent` and `--sidebar-accent` are now `oklch(0.32 0 0)`
  — one visible step above `--muted`, and still AA for `--muted-foreground`
  text (4.89:1). The official dark value (0.371) measures 4.01:1 there, below
  AA, which is why this theme keeps its own step.
- **Semantic text failed AA.** `--success-fg` and `--info-fg` were near-white on
  mid-lightness fills — 3.04:1 and 2.54:1, so every success/info tooltip, UCI
  diff row and badge was below AA. Both now use the near-black canvas value
  (6.2:1 and 7.5:1). Solid destructive fills moved to `--destructive-strong`
  (`oklch(0.56 0.191 22.22)`, 4.92:1 with near-white) instead of the full
  `--destructive` (2.75:1).
- **Every input rendered as a bright grey slab.** The official field utility is
  "30% of `--input`", and `--input` is itself `oklch(1 0 0 / 15%)` — the painted
  fill is 4.5% white. The alpha ladder replaces a literal's alpha instead of
  compositing it, so `--input-a30` produced 30% white: fields came out brighter
  than their card and placeholder text measured 2.55:1. New `--input-fill`
  states the composite; `--input-a30` is no longer emitted. The field border
  went from the official 15% white (1.57:1, invisible) to 35% (3.23:1, WCAG
  1.4.11).
- **Buttons had no focus indicator.** Every input, select, tab and the log
  viewer had a 3px ring; the button family had none, making it the only
  keyboard-reachable control with no visible focus. All button variants now
  carry `focus-visible:border-ring ring-ring-a50 ring-[3px]`. `--ring` moved
  0.556 → 0.60 because the 50% halo alone measured 2.68:1 on `--accent`.
- **The focus-ring contrast check could not fail.** `colorjs.io`'s `contrast()`
  ignores alpha, so a 50%-alpha ring measured as opaque (4.18:1) while painting
  1.87:1. `scripts/check-token-contrast.js` now composites in the correct
  direction and asserts 17 text pairs plus 7 non-text pairs, including the ring
  on all five surfaces it can land on.
- Nine bare `rounded` (4px) rules bypassed the `--radius` ladder; they are
  `rounded-sm` (6px) now, so radii come from the ladder only.
- The zone band (`--zone-color-rgb`) was painted at 65% alpha, putting near-white
  band names at 2.85:1 (lan) and 2.42:1 (wan_6). 30% keeps the swatch readable
  and every default zone colour clears AA.
- `cbi-button-positive` / `-save` used a 15% primary tint, which read as "the
  white button, but disabled" next to apply. They now use the official secondary
  surface — not a green success fill: shadcn/ui has no success button variant,
  this theme's tokens are documented as neutral with destructive as the only
  deliberate hue, and a saturated green button would out-shout the page it sits
  on. `cbi-button-neutral` is explicitly kept in the same family: an earlier pass
  in this release gave it `bg-info` and turned every pager arrow into a solid
  blue block.
- Dashboard: the hourly-bar rail and the ring track were painted with `--muted`
  over a `--card` bed — 1.03:1 and 1.19:1, i.e. not rendered at all. Both now
  use `--muted-foreground` at low alpha (1.41:1 / 1.47:1), and the area fill
  stops dropped from 0.42/0.16 to 0.24/0.10 so the fill sits under the line
  instead of reading as a grey plate.
- Dashboard: sparklines without an axis scaled to their own min..max, so a 1%–7%
  CPU signal filled the whole plot. `lineChart` gained `zero: true` and the CPU
  card plus both rate tiles use it, making the fill proportional to the value.
- Dashboard: `dashClock` was defined twice; the later (epoch-seconds) version
  silently won, so the port card's x-axis labels — fed milliseconds — landed
  around the year 56000. One definition remains, `history.points[].t` is
  converted at the call site, and the diagnose timestamp is converted too.
- Dashboard: the protocol ring's `cap: "round"` swallowed its 3° gaps (a round
  cap adds ~9.3° at each end at r≈40), merging five sectors into one ring; the
  track's round caps also bulged at 12 o'clock. Both are `butt`.
- Dashboard: the port chart drew an area fill for the upload series as well, and
  the two `objectBoundingBox` fills composited into a grey-blue plate that hid
  the blue line. Upload now has `areaClass: null`.
- Dashboard: `rankBar` tweened from zero every refresh (`from` was computed and
  never read), so each host's bar collapsed and regrew once a minute.
- Dashboard: on ≤767px `grid-auto-rows` stayed at the desktop `minmax(20rem,
auto)`, so row tracks were 320px while a stacked card measured 113px — the
  hourly card left a 200px hole. Mobile now resets to `auto`.
- Dashboard: 1024–1279px had no column rule, so four cards landed as 3 + 1 with
  two thirds of the second row empty. That range is now explicitly two columns.
- Dashboard: `grid-auto-rows: 22.5rem` was both floor and ceiling, so a card
  with more content than 360px overflowed into the next row. It is
  `minmax(20rem, auto)`.
- Dashboard: `dashBytes` printed `1000 KB` for 1023488 B, because the carry
  threshold (1024) disagreed with the output rule (no decimals at ≥100).
  `dashPct` dropped trailing zeros, making columns jitter every poll; it now
  always shows one decimal. Uptime under a minute read `0 分`, indistinguishable
  from a failed read; it reads `<1 分`.
- Dashboard: the tile value and its unit rendered at one size, so `GB`/`MB/s`
  competed with the number while `台` beside it did not. Values and units are
  now separate spans; the memory ring no longer repeats the percentage already
  shown in the row above it.
- Dashboard: `.shadcn-dash-tile:hover` lit its border although the tile is not
  clickable — a false affordance, removed. `prefers-reduced-motion` covered
  animations but not the per-poll core-bar height transition or the drawer
  slide; both are disabled now.
- Dashboard: the line card's inner block used `--background`, darker than the
  card it sits in, so nesting read as a hole. It uses `--muted`.
- `.dev/tokens/spec.js` comments name official utilities (`bg-input/30`,
  `bg-destructive/60`). Tailwind's source scan read them as candidates and
  emitted three `color-mix()` rules, which `check-built-css.js` rejects.
  `tokens/**/*.js` is now excluded from the scan.

### Notes

- `ucode` on this build has no `for…of`, no `Math`, no `isNaN`, and its regex
  rejects the `m` flag and `(?:…)` non-capturing groups — the latter fails
  loudly enough to take down every backend method. See
  [.dev/docs/dashboard.md](.dev/docs/dashboard.md) for the full list.
- Budgets in `.dev/tests/build-output.test.js` guard asset growth; they were
  re-based after the dark-only work removed a colour scheme's worth of bytes,
  and raised by the measured 2.1 KB of the component-consistency pass above
  (every per-file limit still passes).

## 0.8.0

- Sidebar layout realignment (v0.7.0 line) concluded: floating inset sidebar,
  grouped navigation, collapsible to icons.
- Client-side router between LuCI view pages, with a full-load fallback.
- On-demand per-page patches for third-party pages.

## 0.7.0

- Reworked the shell around shadcn/ui design language; sidebar replaces the
  horizontal menu.
