# 主题只保留暗色模式，移除浅色

主题此前跟随 `data-darkmode`，在 `tokens/spec.js` 里维护 `light` 与 `dark` 两套派生、在 `defaults.js` 里维护两套输入色，`sidebar-shadcn.js` 提供 `device` / `dark` / `light` 三态切换，`header.ut` 依据 `prefers-color-scheme` 输出两条 `theme-color`。

决定：只保留暗色。移除 `DERIVATIONS.light` 与 `DEFAULTS.light`，`_shared.css` 去掉 `scheme-light` 分支，`header.ut` 只留暗色的 `theme-color`，`shadcn.theme` 的三种取值收敛为单一的暗色主题。用户 localStorage 里遗留的 `light` / `device` 在读取时静默落到暗色，不弹提示、不迁移出第二套状态。

## Considered Options

保留三态但把默认值改成 `dark`。否决：默认值可以改，但切换按钮与两条 `theme-color` 仍在，页面在 `light` 下的表现继续需要维护和验证，而这条路径的成本正是要移除的那部分。

## Consequences

- `pnpm check:contrast` 只需检查暗色一组，`scripts/check-token-contrast.js` 的 `for (const mode of ["light", "dark"])` 循环要跟着改，否则 `resolveMode("light")` 会直接抛错。
- 删除 `light` 之后，暗色 token 是唯一取值来源，任何仍写死浅色值的地方（补丁里的 `filter: invert(1)`、`@media (prefers-color-scheme: light)`、登录页的浅色 fallback）都会显形，应一并清掉。
- 这是一次性、难以回退的决定：恢复浅色需要重建整套 light 派生并重新验证，因此记录在这里。

## `data-darkmode` 保留，且只有一个写入点

移除浅色不等于移除 `data-darkmode`。这个属性在本主题里没有消费者（token 只有一套 `:root`），但**设备上另有三处第三方包靠它选暗色令牌**：

| 包                           | 选择器                        | 影响的令牌                                              |
| ---------------------------- | ----------------------------- | ------------------------------------------------------- |
| `luci-app-dnschain`          | `html[data-darkmode="true"]`  | `--dc-ok` / `--dc-warn` / `--dc-bad` / `--dc-border` 等 |
| `luci-app-trafficctl`        | `:root[data-darkmode="true"]` | `--tc-speed` / `--tc-bg` / `--tc-border` 等             |
| `bootstrap`（`cascade.css`） | `:root[data-darkmode="true"]` | 整条明暗色阶                                            |

真机实测（2026-10-26，DNS 分流页）：在控制台移除该属性后，`--dc-ok` 由 `#4ade80` 变 `#16a34a`、`--dc-border` 由 `rgba(148,163,184,0.28)` 变 `0.35`，页面立刻退回浅色令牌。所以删掉它不会「移除浅色主题」，只会把三个无关页面变成浅色。

因此决定：属性保留，写入点收敛为一处 —— `header.ut` 的预绘制内联脚本。`sidebar-shadcn.js` 原先也写一遍，属同一功能的重复实现，已删除（它只剩清理遗留 `shadcn.theme` 键的职责）。

## 孤立的切换图标一并清掉

`sun.svg` / `moon.svg` / `monitor.svg` 是 `device` / `dark` / `light` 三态切换时期的图标（`monitor` 表「跟随系统」）。三态切换在 9769c42 移除后这三个文件失去全部引用，只是留在磁盘上：

- `.dev/public/shadcn/icons/` 与 `htdocs/luci-static/shadcn/icons/` 各一份 —— 会随包发到设备；
- `.dev/src/assets/icons/` 另有 `sun` / `moon` 两份打包版。

全仓（含构建产物、patch、文档）引用数均为 0，故删除。保留 `circle-dot.svg`（`src/assets` 下，同样零引用但属通用图标集，不是主题切换专有）。

## `site.webmanifest` 的浅色值

同一份 ADR 的连带修复：manifest 里 `theme_color` / `background_color` 仍是 `#ffffff`，与 `header.ut` 声明的 `<meta name="theme-color" content="#0a0a0a">` 冲突，安装为 PWA 时窗口底色会闪白。改为 `#0a0a0a`，即 `--background` 令牌 `oklch(0.145 0 0)` 的 sRGB 值（用 colorjs.io 换算确认）。
