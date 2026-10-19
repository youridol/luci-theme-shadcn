# Sidebar & menu

- `header.ut`: near-minimal shell — empty `#sidebar` plus a parser-blocking inline script right after it that replays the sidebar cache (below) before first paint; sidebar chrome + nav are otherwise built client-side in `menu-shadcn.js`.
- `sidebar-shadcn.js`: state machine for theme (light/dark/device), sidebar collapse/expand, accordion, and mobile drawer — exposed as `window.ShadcnSidebar` after the `shadcn-sidebar-ready` event fires.
- `menu-shadcn.js`: resolves the `admin` branch of `ui.menu.load()`, then renders a two-level sidebar; `ICON_MAP` maps a LuCI menu node's `name` to `/shadcn/icons/*.svg`; deeper levels render as `#tabmenu`. `syncRoute()` re-marks the active sidebar item (same longest-link-prefix rule as the header.ut replay), breadcrumb and tabs from `L.env` after a [router](router.md) swap without rebuilding the sidebar; `closeSurfaces()` closes palette/drawer/popover.

## Row rhythm and the three surface states

## 子菜单：抽屉，不是手风琴

点击（或悬停）一级项会在侧边栏右缘弹出一个**全高抽屉**，列出该分区的子项。
侧边栏本身永远是四行一级项，不展开缩进列表。

```
[侧边栏 256px] │ [抽屉：状态]
 状态  ▸      │   概览
 系统  ▸      │   路由
 服务  ▸      │   防火墙
 网络  ▸      │   …
```

**为什么删掉手风琴。** 子项在两个地方同时出现没有意义，而且点击时侧边栏整列
会跳一下。抽屉全高（`top: 0; height: 100vh`）是因为有的分区子项很多（系统 11 个），
挤进小框里内部滚动比手风琴更难扫。

**子列表在侧边栏里永不展开。** 这靠 CSS 保证，不是靠 JS 逐处防守：
`.sidebar-accordion-sub` 只有收起状态，`[data-open="true"]` 的展开规则已删除。
写 `data-open="true"` 的地方有四处 —— 渲染、缓存回放、路由同步、`header.ut`
预绘制 —— 漏掉任何一处，侧边栏就会在某个时机自己展开。实际踩过的症状是
「从抽屉选了二级菜单，一级项又向下展开」，因为那次点击触发了路由同步。
把展开规则从样式里删掉比在 JS 里追四处可靠，也省掉一个 MutationObserver。
`data-open` 属性仍保留（恢复逻辑与折叠态的面板还读它），但恒为 `false`。

**折叠成图标轨时不弹抽屉**：那个模式本来就用悬浮面板显示子项，再开第二层浮层
是多余的。

## 侧边栏三态

Three states have to stay distinguishable, because the same `bg-sidebar-accent` used to mean all of them:

- **hover** — `bg-sidebar-accent` on a resting row.
- **active section / active sub-item** (`.active`) — `bg-sidebar-accent` + `font-medium`.
- **open section** (`[data-open="true"]`) — 已废弃。子项改由右侧抽屉显示，侧边栏里
  不再有「展开」这个视觉状态；属性保留但恒为 `false`。

Vertical rhythm: top-level rows are 31.5px with `mb-1` (3.5px) between them. The air
between a section header and its list comes from `padding-top` on `.sidebar-sub-list`
(5.25px), never on `.sidebar-accordion-sub`: the grid container's `0fr` collapse treats
padding as a floor. `.sidebar-sub-item:last-child` drops its `mb-1` so the section's own
gap is not doubled against the next header.

## Sidebar cache (anti-flash)

`menu-shadcn.js` snapshots `#sidebar.innerHTML` + scroll position into `sessionStorage['shadcn.sidebar.cache']` (`{v, lang, html, scroll}`) after render and on `pagehide`. The `header.ut` inline script replays it pre-paint on the next navigation, recomputes the active highlight for the current URL (longest link-path prefix — keep in sync with menu-shadcn's dispatchpath matching), restores scroll position, and sets `data-shadcn-built` / `data-shadcn-restored` on `#sidebar`.

When restored, `renderSidebarChrome` only re-syncs the hostname, and `renderSidebarNav` preserves scroll across its authoritative rebuild. Accordion state is **not** restored: the cached markup may still carry `data-open="true"` from an older build, and both the replay and the rebuild force it back to `false` — restoring it would flash an indented list that no longer exists.

Restored HTML loses inline JS handlers (`innerHTML` serialization), so anything that must work before the re-render needs a delegated listener — e.g. the logout click in `header.ut`, which clears the cache and sets `window.shadcnSuppressSidebarCache` so the `pagehide` re-cache stays suppressed.

**Bump `v` whenever the sidebar markup changes shape.**

The theme captures no view transitions (`components/_view-transitions.css` sets `:root { view-transition-name: none }`); swapped and freshly loaded content fades in instead. On desktop, collapsing eases the rail's width (`_layout.css`) and `#main-wrapper`, a flex-1 sibling, follows it frame by frame: the content is pushed, never snapped and slid back. `sidebar-shadcn.js` sets `html[data-sidebar-anim]` on the first toggle so a page load never plays the transition.
