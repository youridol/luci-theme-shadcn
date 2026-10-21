# 图表面积填充允许 SVG 渐变，CSS 渐变继续禁用

## 背景

`adr/0003-no-gradients.md` 规定全主题禁用 gradient 函数，并由
`scripts/check-built-css.js` 机械检查构建产物。那条规则的动机是**视觉上的**：
主题曾经用 `linear-gradient(var(--input-a30), var(--input-a30))` 拿渐变当
「半透明叠加层」使，属于用错工具；而深度应当来自 token 色阶、边框与投影。

概览看板的波形图改版时，参考设计里曲线下方是「线色 → 透明」的竖向渐隐。纯色
低透明度实测下来是一块平涂：暗色卡片底色 `oklch(0.205)`，白色以 0.28 叠上去
只到 `oklch(0.42)` 左右，与曲线上方的空白分不开，填充等于没有。

## 决定

图表**面积填充**允许使用 SVG 的 `<linearGradient>` 作为 paint server。CSS 侧
（`background-image`、`border-image`、`mask-image` 等）的 gradient 函数继续
全禁，`adr/0003` 的其余条款不变。

约束如下，缺一不可：

1. **颜色仍归 CSS**。`<stop>` 只写 `stop-color: currentColor`，`<linearGradient>`
   带 `dash-grad-<tone>` 类，由补丁样式表决定 `color` 是哪个 token。图表代码里
   不出现任何颜色字面量 —— 这是 `adr/0003` 真正要保的东西。
2. **只用于 `fill`**。`stroke` 不许引用渐变：线要能一眼看清走向，渐隐的线在
   端点处会淡到读不出来。
3. **检查仍在**。`check-built-css.js` 的 `forbidden` 列表原样保留 —— SVG paint
   server 不经过 CSS 的 gradient 函数，所以它继续通过。`charts.test.js` 增加
   两条源码级断言：源码里不许出现 `stop-color`，不许出现 `stroke: url(#…)`。
   两条都对着**剥掉注释后的代码**跑，否则解释规则的注释本身会让断言失败。

## 为什么不是「全禁」或「全放开」

- 全禁：面积填充做不出参考设计的方向感，只能平涂。平涂的问题是它与卡片底色
  的对比必须靠提高整体不透明度来换，于是深色卡片上多出一块灰板，比没有填充更
  难看。
- 全放开：`adr/0003` 的检查会失效，而它挡住的不只是图表 —— 那处用 gradient
  冒充叠加层的写法会重新出现。

只放开 SVG paint server 这一条缝，是因为它与「渐变函数」在机制上可区分：检查
脚本匹配的是 CSS 函数名，而 paint server 是元素。

## Consequences

- 面积填充的 stop 透明度成了「填充能不能看见」的唯一开关，改它等于改视觉强度。
  实测 0.42 起手可见，0.28 不可见。
- 渐变锚定在**路径自身的包围盒**（默认 `objectBoundingBox`），不是绘图区。
  贴着基线的序列因此仍在线下方显出颜色：渐隐跑的是它自己那块填充的高度。锚到
  绘图区时亮端固定在图表顶边，低位序列永远够不到，填充就消失了。
- 新增序列色调要同时加 `.dash-line-<tone>`、`.dash-grad-<tone>`、
  `.dash-dot-<tone>` 三条规则。漏掉最后一条会画出「白线 + 蓝点」这种断链。
- `adr/0003` 保留原文，只在开头加一段修订指引，指向本文。
