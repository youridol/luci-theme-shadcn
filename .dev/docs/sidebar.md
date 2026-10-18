# Sidebar & menu

- `header.ut`: near-minimal shell — empty `#sidebar` plus a parser-blocking inline script right after it that replays the sidebar cache (below) before first paint; sidebar chrome + nav are otherwise built client-side in `menu-shadcn.js`.
- `sidebar-shadcn.js`: state machine for theme (light/dark/device), sidebar collapse/expand, accordion, and mobile drawer — exposed as `window.ShadcnSidebar` after the `shadcn-sidebar-ready` event fires.
- `menu-shadcn.js`: resolves the `admin` branch of `ui.menu.load()`, then renders a two-level sidebar; `ICON_MAP` maps a LuCI menu node's `name` to `/shadcn/icons/*.svg`; deeper levels render as `#tabmenu`. `syncRoute()` re-marks the active sidebar item (same longest-link-prefix rule as the header.ut replay), breadcrumb and tabs from `L.env` after a [router](router.md) swap without rebuilding the sidebar; `closeSurfaces()` closes palette/drawer/popover.

## Row rhythm and the three surface states

Three states have to stay distinguishable, because the same `bg-sidebar-accent` used to mean all of them:

- **hover** — `bg-sidebar-accent` on a resting row.
- **open section** (`[data-open="true"]`) — resting surface, `--sidebar-foreground` label only. It is _not_ an active state; taking the accent surface here made an open-but-unrelated section look identical to the current page.
- **active section / active sub-item** (`.active`) — `bg-sidebar-accent` + `font-medium`. The explicit `.sidebar-nav-item.active > .sidebar-nav-parent` / `.sidebar-accordion-item.active > .sidebar-nav-parent` rules sit _after_ the open-only rule: both selectors are equal on specificity, so source order is what lets active win.

Vertical rhythm: top-level rows are 31.5px with `mb-1` (3.5px) between them. The gap only ever applied _between_ top-level rows, so an open section's highlight ran straight into the row under it — parent bottom and first sub-item top both sat at y=87.5px on the reference device and the two accent surfaces read as one block. The air now comes from `padding-top` on `.sidebar-sub-list` (5.25px), never on `.sidebar-accordion-sub`: the grid container's `0fr` collapse treats padding as a floor and the section would not close flush. `.sidebar-sub-item:last-child` drops its `mb-1` so the section's own gap is not doubled against the next header.

## Sidebar cache (anti-flash)

`menu-shadcn.js` snapshots `#sidebar.innerHTML` + scroll position into `sessionStorage['shadcn.sidebar.cache']` (`{v, lang, html, scroll}`) after render and on `pagehide`. The `header.ut` inline script replays it pre-paint on the next navigation, recomputes the active highlight for the current URL (longest link-path prefix — keep in sync with menu-shadcn's dispatchpath matching), restores accordion/scroll state, and sets `data-shadcn-built` / `data-shadcn-restored` on `#sidebar`.

When restored, `renderSidebarChrome` only re-syncs the hostname, and `renderSidebarNav` preserves accordion/scroll across its authoritative rebuild.

Restored HTML loses inline JS handlers (`innerHTML` serialization), so anything that must work before the re-render needs a delegated listener — e.g. the logout click in `header.ut`, which clears the cache and sets `window.shadcnSuppressSidebarCache` so the `pagehide` re-cache stays suppressed.

**Bump `v` whenever the sidebar markup changes shape.**

The theme captures no view transitions (`components/_view-transitions.css` sets `:root { view-transition-name: none }`); swapped and freshly loaded content fades in instead. On desktop, collapsing eases the rail's width (`_layout.css`) and `#main-wrapper`, a flex-1 sibling, follows it frame by frame: the content is pushed, never snapped and slid back. `sidebar-shadcn.js` sets `html[data-sidebar-anim]` on the first toggle so a page load never plays the transition.
