# 概览页看板由补丁接管 `#view`，并保留原生概览作为逃生口

概览页（`admin/status/overview`）是 LuCI 的 `template` 节点，服务端先渲染 Lua include，再实例化 `view.status.index`；主题只拥有 `header.ut` / `footer.ut` / `sysauth.ut` 三个模板，改不动这个节点本身。要把整页变成看板，只有三条路：接管 `#view` 的子节点、另写一个 `luci-app-*` 自带 view，或者在原生区块之上叠一层。

选择接管 `#view`：由现有的 on-demand patch 机制加载 `admin-status-overview.js` 与同名 CSS，脚本在原生区块渲染完成后隐藏它们并插入看板，同时提供一个「显示原生概览」开关。理由是这条路径不需要新包、不改 luci-base、不碰设备的 `menu.d`，与本仓库「补丁只做本页局部」的纪律一致，并且卸载/重建由客户端路由已有的 `window.luciPatches[stem] = { mount, unmount }` 约定管住。

另写一个应用会把范围从「主题」变成「应用」（要进 feeds、要独立版本号、要处理用户没装的情况），本轮不做。

## Consequences

- 看板必须与 LuCI 的原生渲染时序配合：`#view` 是异步填充的，脚本求值时它可能还不存在。现有的 `MutationObserver` + 兜底定时器模式要继续沿用。
- 隐藏原生区块的动作只能在脚本确实接管成功之后执行。脚本未运行时页面必须照常可读，这条在无 JS 或脚本被拦截时决定整个概览页是否还能用。
