# Sidebar & menu

- `header.ut`: near-minimal shell — empty `#sidebar` plus a parser-blocking inline script right after it that replays the sidebar cache (below) before first paint; sidebar chrome + nav are otherwise built client-side in `menu-shadcn.js`.
- `sidebar-shadcn.js`: state machine for theme (light/dark/device), sidebar collapse/expand, accordion, and mobile drawer — exposed as `window.ShadcnSidebar` after the `shadcn-sidebar-ready` event fires.
- `menu-shadcn.js`: resolves the `admin` branch of `ui.menu.load()`, then renders a two-level sidebar; `ICON_MAP` maps a LuCI menu node's `name` to `/shadcn/icons/*.svg`; deeper levels render as `#tabmenu`. `syncRoute()` re-marks the active sidebar item (same longest-link-prefix rule as the header.ut replay), breadcrumb and tabs from `L.env` after a [router](router.md) swap without rebuilding the sidebar; `closeSurfaces()` closes palette/drawer/popover.

## 桌面侧边栏：默认收起，悬浮展开，点击钉住

三种状态，由两个属性分工表达：

| 状态         | `#sidebar[data-collapsed]` | `html[data-sidebar-floating]` | 宽度  | 占位                         |
| ------------ | -------------------------- | ----------------------------- | ----- | ---------------------------- |
| 收起（默认） | `true`                     | 无                            | 48px  | 是（3rem 图标轨）            |
| 悬浮展开     | `false`                    | `true`                        | 256px | **否**（绝对定位盖在内容上） |
| 固定展开     | `false`                    | 无                            | 256px | 是                           |

**为什么悬浮展开必须脱离文档流。** `body` 是 flex 行，侧边栏是它的 flex 项，
`#main-wrapper` 是 `flex-1`。悬浮展开若走正常流，侧边栏一宽主内容就跟着缩，
指针每次扫过侧边栏整页重排一次 —— 比一直展开更烦人。加上 floating 之后它
`position: absolute` 盖上去，`#main-wrapper` 自己补满整行，布局完全不动。
实测：悬浮时 `#main-wrapper` 的 `left` 保持 0、宽度保持 1400；固定展开时
才变成 `left: 256` / 宽 1144。

**为什么 `floating` 挂在 `<html>` 而不是 `#sidebar`。** CSS 规则写作
`html[data-sidebar-floating="true"] #sidebar`。第一版把属性写在 `#sidebar` 上，
属性值对了但选择器匹配不到，`position` 仍是 `static`，主内容照样被挤动。

**悬浮只用 JS 置位，不写 `:hover`。** `data-collapsed` 还要给折叠面板与手风琴
读；如果 CSS 用 `:hover` 判断、JS 用属性判断，两套判据会各说各话（CSS 认为在
悬浮、JS 认为已收起）。所以统一由 `_applyCollapsed()` 写两个属性，CSS 只认属性。

**悬浮展开不播宽度过渡。** `_applyCollapsed(…, {animate:false})` 会摘掉
`data-sidebar-anim`；200ms 的宽度动画在指针划过去时既拖沓，又让浮层跟不上指针。
点按钮的固定展开才播。

**持久化只记「固定展开」**，键 `shadcn.sidebar.pinned`。悬浮是瞬时状态，写进
存储会让刷新后的状态取决于上次指针停在哪里。旧键 `shadcn.sidebar` 存的是
「是否收起」，语义相反，不迁移 —— 读它只会让曾经收起过的用户「恰好」符合新默认。

`header.ut` 的预绘制脚本读同一个键，否则首帧画成展开、随后跳回收起。

### 退场：先看指针去了哪，再决定收不收

子菜单抽屉挂在 `body` 上、贴着侧边栏右缘（`left = 侧边栏 right`）。两者不重叠，
所以「从侧边栏内的菜单项水平右移到抽屉」**必然**先经过一次 `pointerleave`。

第一版收到 `pointerleave` 就立刻收起，结果是抽屉还开着、侧边栏却缩回图标轨
（截图里那个状态），随后抽屉失去依托也关掉 —— 二级菜单根本点不到。

现在的退场判定分三步：

1. `pointerleave` 不直接收，起一个 120ms 宽限计时（`_scheduleLeave`）；
2. 计时到期时看指针坐标是否落在抽屉/收起态浮层的矩形内（`_pointerOverPanel`），
   在框里就不收；
3. 指针从抽屉直接移向内容区时，抽屉自己的 `pointerout` 会重新排一次收起 ——
   少了这一条，侧边栏早就不再收到 `pointerleave`（指针本就不在侧边栏里），
   抽屉会永远挂着。

**为什么用坐标而不是 `:hover`。** 宽限期只有一帧级别，而浏览器把指针标记为
`:hover` 需要先派发过对应的 `pointerover`。实测在「离开侧边栏、进入抽屉」这一次
跨越里，120ms 到期时 `#sidebar-subdrawer:hover` 还是 `false`（指针坐标已在抽屉内，
hover 状态没落地），于是误判成「没在面板上」直接收起。矩形判断不依赖事件时序。
为此 `_initHoverExpand` 在 `document` 上挂了一个 `pointermove` 记录 `this._pointer`。

**点二级项之后收整层浮面。** `menu-shadcn.js` 的链接点击调
`ShadcnSidebar.collapseAfterNavigate()`：关抽屉 + 收起侧边栏。它**不动 pinned** ——
用户先前点按钮钉住的偏好不该被一次导航改掉，所以只在「不是固定展开」时才收。
收起时 `_applyCollapsed` 还会顺手 `closeSubDrawer()`，保证两层浮面要么都开、要么都关。

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
