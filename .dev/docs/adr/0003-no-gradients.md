# 禁止渐变，深度一律用色阶、边框与投影表达

> **修订（adr/0009）**：图表**面积填充**改用 SVG `<linearGradient>` 作为 paint
> server，颜色仍由 CSS 类给出。CSS 侧的 gradient 函数继续全禁，本文其余条款
> 不变。修订范围见 [0009-svg-area-gradient.md](0009-svg-area-gradient.md)。

主题里曾经唯一使用渐变的语法是 `components/_select.css` 的 `background-image: linear-gradient(var(--input-a30), var(--input-a30))`，它并不是视觉渐变，只是拿 gradient 当「半透明叠加层」使，让 `<select>` 的原生下拉浮层从 `--popover` 这个不透明底继承，同时触发器表面还保留输入框的 tint。现在全仓已无任何 gradient 函数。

决定：全主题禁用 `linear-gradient` / `radial-gradient` / `conic-gradient` / `repeating-*-gradient`。需要表面差异时只用四样东西：token 色阶（background / card / muted / accent 的明度差）、1px 边框、投影、以及纯色不同的 `fill` / `stroke`。

`_select.css` 那一处改成等效的纯色叠加：触发器继续 `bg-popover` 作底，tint 用一层绝对定位的伪元素铺 `--input-a30` 纯色，视觉不变而不引入 gradient。

## Consequences

- 图表因此天然只有纯色填充。等距投影的柱体靠顶面、侧面、正面三个明度不同但同色的 `fill` 表达，不需要渐变，与本约束互相成全。
- 这条约束可被机械检查：构建产物里出现任一 gradient 函数即失败。已落在 `scripts/check-built-css.js` 的 `forbidden` 列表里，与 `color-mix()`、相对 `oklch()` 并列；`pnpm build` 的 `check:colors` 步会跑它。反向验证过一次：注入一条 `linear-gradient` 后脚本以 exit 1 失败并报 `main.css: gradient × 1`，恢复后重新通过 —— 它是真的在检查，不是空跑。
- 渐变是常见的「压平一切」手段，禁止后必须靠 token 明度阶梯维持层次；新增表面时先确认 `--background` / `--card` / `--muted` 三级的对比是否够用，不够就补 token，不要在组件里现调。
