# 图标统一为 mask 盒子 + `currentColor`，删除 `filter` 反色

主题的图标本来已经是 SVG 文件（`public/shadcn/icons/*.svg`），但通过 `<img>` 加载，颜色由 `_shared.css` 里 `filter: brightness(0) saturate(100%)`（暗色下再加 `invert(1)`）强制反色。这套做法的后果：图标不跟随 `currentColor`，hover 变色要另写 opacity 阶梯，`prefers-contrast` 与强制色彩模式下不可控，且 `<img>` 里的 SVG 无法被主题 token 单独着色。

决定：UI 图标改为**图标盒子** —— 一个空的 `<span class="shadcn-icon">`，用 `mask` 裁出形状、`bg-current` 上色，颜色因此永远等于周围文字的颜色。`_shared.css` 的 `filter` 反色规则整体删除，侧边栏、卡片头、命令面板、登录页的图标一并切换。

## 为什么是 mask 而不是内联 `<svg>`

最初的方向是把 SVG 直接写进 DOM，让描边的 `currentColor` 生效。落地时发现 CSS 侧早就在用 mask 了（`_select.css` 的下拉箭头、`_palette.css` 的搜索图标、`_input.css` 的勾选标记等 11 处，全部 `mask` + `bg-current`），而模板与 `menu-shadcn.js` 走的是 `<img>` + `filter`。两套机制并存正是不一致的来源。统一到 mask 的代价最小：那 11 处不用动，只需要把 `<img>` 那边的 7 处改过来。

mask 还顺带解决了两件事：图标名可以在运行时拼（`ICON_MAP` 继续按名选择），以及不需要为每个图标维护一份内联片段表。

## 两个 URL 来源

`--shadcn-icon` 这个自定义属性指向哪里，取决于标记由谁拥有：

- 主题自己写的静态标记（登录页的 `user` / `lock` / `eye`）走 `@assets/…`，Vite 把它内联成 data URI，不产生请求；
- 运行时按名生成的图标（侧边栏分区、面包屑箭头）指向 `/icons/<name>.svg`，因为打包后的 data URI 无法从 JS 里寻址。

登录页那四个图标属于第二类：`eye` / `eye-off` 只存在于 `public/`，`src/assets/icons/` 从来没有它们。为了走 data URI 而把文件复制进两个目录，等于用「多一份资产副本」换「少两个请求」，不划算。

## Consequences

- 图标不能靠 `src` 换名做状态切换（登录页的 `eye` / `eye-off` 就是一例），改成重写 `--shadcn-icon`。
- `img.shadcn-icon` 选择器与它的 opacity 阶梯消失，换成 `.shadcn-icon` 上的同一套阶梯。
- 品牌 logo 不在此列：它是双色图形（黑底 + 白笔画），mask 只能单色，所以仍是 `<img>`。位图资产（`favicon.ico`、`apple-touch-icon.png`、登录页 `login-bg.jpeg`）同理不在此列。
- 尺寸用 px 而不是 rem：本主题根字号是 14px，`1rem` 会让 16px 的图标渲染成 14px。
