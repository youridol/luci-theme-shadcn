# 主题只保留暗色模式，移除浅色

主题此前跟随 `data-darkmode`，在 `tokens/spec.js` 里维护 `light` 与 `dark` 两套派生、在 `defaults.js` 里维护两套输入色，`sidebar-shadcn.js` 提供 `device` / `dark` / `light` 三态切换，`header.ut` 依据 `prefers-color-scheme` 输出两条 `theme-color`。

决定：只保留暗色。移除 `DERIVATIONS.light` 与 `DEFAULTS.light`，`_shared.css` 去掉 `scheme-light` 分支，`header.ut` 只留暗色的 `theme-color`，`shadcn.theme` 的三种取值收敛为单一的暗色主题。用户 localStorage 里遗留的 `light` / `device` 在读取时静默落到暗色，不弹提示、不迁移出第二套状态。

## Considered Options

保留三态但把默认值改成 `dark`。否决：默认值可以改，但切换按钮与两条 `theme-color` 仍在，页面在 `light` 下的表现继续需要维护和验证，而这条路径的成本正是要移除的那部分。

## Consequences

- `pnpm check:contrast` 只需检查暗色一组，`scripts/check-token-contrast.js` 的 `for (const mode of ["light", "dark"])` 循环要跟着改，否则 `resolveMode("light")` 会直接抛错。
- 删除 `light` 之后，暗色 token 是唯一取值来源，任何仍写死浅色值的地方（补丁里的 `filter: invert(1)`、`@media (prefers-color-scheme: light)`、登录页的浅色 fallback）都会显形，应一并清掉。
- 这是一次性、难以回退的决定：恢复浅色需要重建整套 light 派生并重新验证，因此记录在这里。
