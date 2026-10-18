# 图表手写 SVG 生成器，补丁 JS 不进打包

补丁 JS（`src/resource/patches/*.js`）不经过 Rollup：`vite.config.ts` 的 `createLuciJsCompressPlugin` 把每个文件当文本读进来，只跑一次 terser，没有 `import` 解析。因此补丁里无法 `import` npm 依赖，只能用 LuCI 运行时的 `require` 语义。补丁 CSS 是 Rollup entry，补丁 JS 不是。

看板需要波形、柱状、等距 3D 柱、环形、径向仪表、排行条、热力格等十余种表达。可选：让补丁也走打包以引入图表库，或者手写。

决定：手写。每种图表就是把一个数值数组映射成 `path` / `rect` / `circle` 的字符串，总量在数百行量级。图表原语放在 `src/resource/patches/_charts.js`，由使用它的补丁用一行 `//#include ./_charts.js` 在构建期内联进来 —— 补丁仍然是一个扁平文件，只是它自己带着图表代码。

## Considered Options

把补丁 JS 纳入 Rollup，从而能引一个轻量图表库。否决的理由不是体积而是机制：补丁会从「一个文件、一次 terser、产物与源同名同路径」变成带共享 chunk 的产物，`header.ut` 用 `fs.lsdir()` 发现补丁、把它写进 `body[data-patches]`、路由再按页 `disabled`/`enable` 与 `mount`/`unmount` 这一整套约定都建立在「补丁是一个可直接 `<script defer>` 的扁平文件」之上。改造这套机制的风险远大于手写几张图。

## `_charts.js` 怎么进入补丁

补丁不能 `import`，但也不想把图表代码复制进每个使用者，所以压缩插件支持一个极小的一层内联指令：

```
//#include ./_charts.js
```

它按相对路径读文件、原地替换，目标不存在时**让构建失败**（静默失败会发出一个一加载就抛错的补丁）。`_` 前缀的补丁文件被排除在产物之外，所以 `_charts.js` 不会作为一个从不被请求的文件出现在 `patches/` 里。这是 `vite.config.ts` 唯一的改动，且只影响用了这条指令的文件。

## Consequences

- 图表代码没有第三方测试覆盖，正确性靠 `tests/charts.test.js` 的几何断言（输入数组 → path 内容的性质，例如「空值必须断开子路径」「柱体不得越出 viewBox」「环形小扇区不得反转」）与真机目视。
- 零 canvas、零 WebGL：输出全是 SVG，能被主题 token 直接着色，也天然满足「禁止渐变」。
- 每次加一种新图形都要自己写，不要再回头考虑引库。
