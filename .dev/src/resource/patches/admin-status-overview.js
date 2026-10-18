"use strict";
/* Shadcn online-host details — enhances the Overview page's “在线主机” table.

   The stock table renders each host as plain text, so a host cannot be drilled
   into. This patch turns the host name and the IPv4 address into buttons that
   open a slide-over drawer listing that host's live connections, fed by the
   `shadcn` rpcd object this package installs (see root/usr/share/rpcd/ucode).

   The drawer polls on its own interval (default 1 s, user-selectable 1–5 s from
   the toolbar) because the rate columns are byte deltas between two samples —
   a single fetch can only show cumulative totals.

   Everything is scoped to the Overview page and torn down on unmount, so the
   theme's client-side router can move in and out of the page freely. */
(function () {
  // Chart primitives, inlined at build time: patches are copied through terser
  // rather than bundled, so an `import` here would never resolve.
  //#include ./_charts.js

  // Must equal this file's stem: the router resolves patches as
  // `window.luciPatches[stem]`, where stem is "admin-status-overview". It used
  // to say "admin-status-overview-detail", which nothing ever looked up — so
  // `unmount()` was never called on navigation and every listener this patch
  // owns outlived the page.
  const PATCH = "admin-status-overview";

  // Refresh presets offered in the toolbar, in seconds. 1 s leads because the
  // drawer is for watching live traffic; the longer ones trade freshness for
  // less work on the router.
  const INTERVALS = [1, 2, 3, 4, 5];
  const DEFAULT_INTERVAL = 1;

  // The stock table is identified by its id; row parsing keys off its headers
  // rather than fixed column indices, so a LuCI release that reorders or adds
  // columns does not silently bind the wrong cell.
  const LEASES_TABLE_ID = "status_leases";

  let pollTimer = null;
  let drawer = null;
  let current = { host: null, interval: DEFAULT_INTERVAL, seq: 0 };
  let enrichObserver = null;
  let enrichTimer = null;
  // 目的地址 -> 域名。反查结果按地址缓存，避免每轮刷新都重算。
  // 只存本地已知的解析结果，查不到就不进缓存，下轮重试。
  const domainCache = new Map();

  // 本机所在的局域网网段。用来把“外网地址”这一列填成真正的公网对端，
  // 而不是把目的地址重复一遍。
  //
  // 网段由后端在 connections 的返回里给出（它读 /etc/config/network，
  // 不需要前端申请 network 接口权限）。后端没给就退化为按私有地址段判断。
  let lanPrefix = null;

  function isPrivateV4(ip) {
    if (!ip) return false;
    const p = ip.split(".").map(Number);
    if (p.length !== 4 || p.some((n) => !isFinite(n))) return false;
    return (
      p[0] === 10 ||
      (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
      (p[0] === 192 && p[1] === 168)
    );
  }

  // ── helpers ──────────────────────────────────────────────────────────

  function fmtBytes(n) {
    if (n == null || !isFinite(n)) return "—";
    if (n < 1024) return Math.round(n) + " B";
    const units = ["KB", "MB", "GB", "TB"];
    let v = n / 1024;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) {
      v /= 1024;
      i++;
    }
    return (v >= 100 ? v.toFixed(0) : v.toFixed(1)) + " " + units[i];
  }

  // 速率统一换算到 B/s 展示，与累计列区分开。
  // 小于 1 KB/s 的时刻意保留一位小数：0 / 1 位都无法体现“正在跑”，
  // 而固定成整数会把 48.7 显示成 49，和累计列的量级对不上。
  function fmtRate(n) {
    if (n == null || !isFinite(n)) return "—";
    if (n < 1024)
      return (n >= 10 ? Math.round(n) : Math.round(n * 10) / 10) + " B/s";
    return fmtBytes(n) + "/s";
  }

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  // 从一个单元格的文本里取第一个地址。LuCI 会把一台主机的多个 IPv4
  // 直接拼在同一个格子里（两个 <div>，中间没有分隔符），textContent
  // 读出来就是 "192.168.3.194192.168.3.233" —— 所以按正则抠第一个地址，
  // 而不是按空白切分。
  function firstAddress(text, pattern) {
    if (!text) return null;
    const src = String(text);
    // IPv4 优先逐段匹配；IPv6 用更宽的模式
    const re =
      pattern === "v4"
        ? /(?:^|[^0-9])([0-9]{1,3}(?:\.[0-9]{1,3}){3})/g
        : /(?:^|[^0-9a-f:])([0-9a-f]{1,4}(?::[0-9a-f]{0,4}){2,})/gi;
    const m = re.exec(src);
    if (!m) return null;
    const addr = m[1];
    if (addr === "-") return null;
    if (pattern === "v4") {
      // 逐段校验范围，避免把 "999.1.1.1" 当成地址
      const parts = addr.split(".").map(Number);
      if (parts.some((n) => n > 255)) return null;
    }
    return addr;
  }

  // ── table enrichment ─────────────────────────────────────────────────

  // 取表头文字到列序号的映射。没有 thead 时退回第一行。
  function headerMap(table) {
    const row = table.querySelector("thead tr") ?? table.querySelector("tr");
    if (!row) return null;
    const map = {};
    const cells = row.querySelectorAll("th, td");
    for (let i = 0; i < cells.length; i++) {
      const t = (cells[i].textContent || "").trim();
      if (t) map[t] = i;
    }
    return map;
  }

  // 把主机名格与 IPv4 格标记成可点击入口。
  //
  // 这里刻意不插入任何元素：LuCI 每 5 秒重写整行内容，插进去的按钮会被抹掉，
  // 要等下一轮补回 —— 实测空窗 437~515ms，用户能看到链接变回普通文字、再变
  // 回来。改成在单元格本身打属性（CSS 负责外观，事件委托负责点击），重写
  // 内容不会影响这套机制，也就没有空窗。
  //
  // 可查询地址放在 data-shadcn-host 上；一台主机有多个地址时，每个地址各占
  // 一个子容器，点击时按被点到的那一个决定目标。
  function markCell(cell, host, opts) {
    if (!cell || !host) return;

    const o = opts ?? {};

    cell.classList.add("shadcn-host-cell");
    cell.dataset.shadcnHost = host;
    if (o.entries) cell.dataset.shadcnEntries = o.entries;

    // 单行省略可能把地址截断，给出完整提示
    cell.title = "查看 " + host + " 的实时连接";
  }

  // 取被点击元素所属的可查询地址：优先最近祖先上的 data-shadcn-addr
  // （多地址格子给每个子容器单独标注），否则用单元格自己的 data-shadcn-host。
  function hostFromEvent(ev) {
    const el0 = ev.target;
    if (!el0 || !el0.closest) return null;

    const addrNode = el0.closest("[data-shadcn-addr]");
    if (addrNode) return addrNode.dataset.shadcnAddr;

    const cell = el0.closest("[data-shadcn-host]");
    return cell ? cell.dataset.shadcnHost : null;
  }

  function enrichTable() {
    const table = document.getElementById(LEASES_TABLE_ID);
    if (!table) return false;

    const map = headerMap(table);
    if (!map) return false;

    const iName = map["主机名"];
    const iV4 = map["IPv4 地址"];
    const iV6 = map["IPv6 地址"];
    if (iName == null && iV4 == null) return false;

    const rows = table.querySelectorAll("tr");
    for (let r = 0; r < rows.length; r++) {
      const cells = rows[r].querySelectorAll("td");
      if (!cells.length) continue;

      const nameCell = iName != null ? cells[iName] : null;
      const v4Cell = iV4 != null ? cells[iV4] : null;

      // 一台主机可能有多个地址，单元格文本会粘连；只取第一个可用地址，
      // 否则拼出来的字符串既查不到连接，也不是一个真实地址。
      const v4 = firstAddress(v4Cell?.textContent, "v4");
      const v6 = firstAddress(iV6 != null ? cells[iV6].textContent : "", "v6");
      // 主机的可查询地址：优先 IPv4，没有就用 IPv6
      const host = v4 ?? v6;
      if (!host) continue;

      // 主机名格：整格一个入口，指向该行主机的首个地址
      markCell(nameCell, host);

      // IPv4 格：可能有多条地址，逐个子容器标注，点哪个进哪个
      if (v4Cell) {
        const leaves = [...v4Cell.querySelectorAll("div, span")].filter(
          (n) => n.children.length === 0,
        );
        const targets = leaves.length ? leaves : [v4Cell];
        const addrs = [];

        for (const node of targets) {
          const addr = firstAddress((node.textContent || "").trim(), "v4");
          if (!addr) continue;
          node.dataset.shadcnAddr = addr;
          addrs.push(addr);
        }

        // 单元格本身也标上，作为兜底（点到空白处时用它）
        if (addrs.length) markCell(v4Cell, addrs[0], { entries: addrs.length });
      }
    }

    return true;
  }

  // 表格是异步填充的，且用户可隐藏/展开该区块，所以持续观察。
  //
  // 只打属性、不插元素，所以重写内容不会让“链接”消失，只是标记需要补回。
  // 这里不用 requestAnimationFrame 合并：LuCI 重绘一次会产生成百上千条
  // 变更记录，等到下一帧再补会让标记空缺约 450ms。改成同步补 —— 观察器
  // 回调本身就在微任务里批量执行，逐条重排的代价小于半秒的可视空缺。
  function watchTable() {
    if (enrichObserver) return;

    enrichObserver = new MutationObserver(function (records) {
      // 只关心表格区域的变化，页面其它地方（抽屉、菜单）不必重扫
      const table = document.getElementById(LEASES_TABLE_ID);
      if (!table) return;

      for (const rec of records) {
        const t = rec.target;
        const node = t.nodeType === 1 ? t : t.parentElement;
        if (node && (node === table || table.contains(node))) {
          enrichTable();
          return;
        }
      }
    });

    enrichObserver.observe(document.body, {
      childList: true,
      characterData: true,
      subtree: true,
    });

    // 兜底：初次挂载时表格可能还没渲染出来
    enrichTimer = window.setInterval(enrichTable, 500);
    enrichTable();
  }
  // ── 指标带 ───────────────────────────────────────────────────────────

  // 概览页原本是一列「标签 / 值」表格，最先要看的四个数埋在下面几屏。
  // 这里在原生区块之前插一条磁贴带，数值全部从页面已有的表格里读，不另外
  // 请求一次 ubus：同一时刻只存在一个数据源，磁贴与下方表格不会互相矛盾。
  //
  // 折线的历史来自本页自己的采样：每轮把 CPU 使用率与 WAN 速率压进定长
  // 环形数组，页面一打开先是一条平线，几秒后才成形。这是真实观测序列，
  // 不是画出来的示意图。

  // ══ 概览看板 ═══════════════════════════════════════════════════════════
  //
  // 原生概览是一列「标签 / 值」表格，运维要看的四个数埋在下几屏。这一段把
  // 整页换成看板：概况带 + 线路 + 资源 + 流量四组，数据来自 shadcn.dashboard
  // （root/usr/share/rpcd/ucode/shadcn.uc）。
  //
  // 两条通道的成本差两个数量级（真机实测 ≈1000 条连接）：
  //   fast ≈  10 ms  → 用户可选 1/2/5/10/30 秒，默认 1 秒
  //   slow ≈ 630 ms  → 固定 60 秒，绝不进快周期
  //
  // 三条硬规矩（见 .dev/docs/dashboard.md 与 adr/0001–0007）：
  //   · 原生区块只在看板确实挂上之后才隐藏 —— 没有 JS 或被拦时页面照旧；
  //   · 刷新失败保留上一帧，并说明过期多久，不闪空、不把错误画成 0；
  //   · 设备给不出的指标显示「不可用 · 原因」，卡片不消失、位置不跳动。
  //
  // 本文件中所有看板内部符号都用 dash 前缀：与上面的抽屉共用同一个 IIFE，
  // 而 el / series / push 这些名字已经被抽屉占用了。

  // 用户可选的快路径间隔（秒）。
  //
  // 默认 5 秒而不是 1 秒：真机实测（LEDE 24.10.5 / x86_64）浏览器侧一次
  // rpcd 往返约 **1 秒**，而同样的调用在本机 `ubus call` 只要 10 ms ——
  // 也就是说 1 秒的固定成本在 HTTP 层，不在采集器。连 LuCI 自己的
  // `system.board` 都要 469–1002 ms，所以这不是我们的后端慢。
  //
  // 1 秒仍然保留在预设里：局域网有线条件下它有意义，但默认值不该把它
  // 当成常态。上限 60 秒与慢路径对齐。
  const DASH_FAST_PRESETS = [1, 2, 5, 10, 30, 60];
  const DASH_DEFAULT_FAST = 5;
  const DASH_SLOW_MS = 60000;

  // 一次快路径超过这个耗时就把间隔放宽一档并在状态行说明。
  //
  // 阈值取「两倍默认间隔」而不是一个绝对毫秒数：绝对阈值在任何设备上都
  // 会误判 —— 早先写的 400 ms 在往返本来就有 1 秒的机器上每次都触发，
  // 于是看板一打开就显示「已降速」，而实际并没有变慢。
  function dashDegradeThreshold() {
    return Math.max(dashIntervalMs * 2, 1500);
  }

  // 每条序列保留多少点。1 秒间隔下是最近 ~2 分钟，正好是运维盯着的窗口。
  const DASH_SERIES_LEN = 120;

  function dashMedia() {
    return String(
      document.documentElement.getAttribute("data-shadcn-media") ||
        "/luci-static/shadcn",
    ).replace(/\/$/, "");
  }

  function dashBytes(v) {
    if (v == null || !isFinite(v)) return "—";
    if (v < 1024) return Math.round(v) + " B";
    const units = ["KB", "MB", "GB", "TB", "PB"];
    let x = v / 1024;
    let i = 0;
    while (x >= 1024 && i < units.length - 1) {
      x /= 1024;
      i++;
    }
    return (x >= 100 ? x.toFixed(0) : x.toFixed(1)) + " " + units[i];
  }

  function dashRate(v) {
    if (v == null || !isFinite(v)) return "—";
    if (v < 1024)
      return (v >= 10 ? Math.round(v) : Math.round(v * 10) / 10) + " B/s";
    return dashBytes(v) + "/s";
  }

  // 从能力探测给的网口名里挑出 WAN。
  //
  // 后端只回报端口名（caps.ports），不认识「哪条是 WAN」—— 那取决于拨号
  // 方式（pppoe / dhcp / 静态），硬编码前缀在别处就错。这里按常见命名
  // 优先级挑，挑不到就返回 null，由调用方显示「未识别」，而不是随便挑
  // 一个网口冒充 WAN。
  function dashWanName() {
    const ports = (dashCaps && dashCaps.ports) || [];
    const pick = function (re) {
      for (const p of ports) if (re.test(p)) return p;
      return null;
    };
    return pick(/^pppoe-/) || pick(/^(wan|wwan)\d*$/) || pick(/^wan/) || null;
  }

  // 一位小数：整数会把 3.4% 与 4.4% 显示成同一个数，而 "—" 又必须能和
  // "0%" 区分开。
  function dashPct(v) {
    if (v == null || !isFinite(v)) return "—";
    return (Math.round(v * 10) / 10).toString() + "%";
  }

  // 秒数 → 「3 天 5 小时」这类可读时长。
  //
  // 只保留两级：路由器上「3 天 5 小时 12 分」里的分钟没有决策价值，反而让
  // 一行文字变长后在磁贴里被省略号截断。
  function dashDuration(sec) {
    if (sec == null || !isFinite(sec) || sec < 0) return "—";
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    if (d > 0) return d + " 天 " + h + " 小时";
    if (h > 0) return h + " 小时 " + m + " 分";
    return m + " 分";
  }

  function dashClock(epochSec) {
    if (epochSec == null || !isFinite(epochSec)) return "—";
    const d = new Date(epochSec * 1000);
    const p = (x) => String(x).padStart(2, "0");
    return p(d.getHours()) + ":" + p(d.getMinutes());
  }

  const dashSeries = {
    cpu: [],
    up: [],
    down: [],
    temp: [],
    conns: [],
    mem: [],
  };

  let dashBoard = null;
  let dashFastTimer = null;
  let dashSlowTimer = null;
  let dashIntervalMs = DASH_DEFAULT_FAST * 1000;
  let dashPaused = false;
  let dashInflight = false;
  let dashLastError = null;
  let dashLastOkAt = null;
  let dashSlow = null;
  let dashCaps = null;
  let dashDegraded = false;
  let dashViewObserver = null;
  let dashViewReady = false;
  let dashRpc = null;

  function dashEl(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  // 一个磁贴。slot 始终存在，所以磁贴在「有图形」和「没有图形」两种状态
  // 下高度一致，数据到达时不会把下面整页推下去。
  function dashTile(key, label, iconName) {
    const box = dashEl("div", "shadcn-dash-tile");
    box.dataset.tile = key;

    const head = dashEl("div", "shadcn-dash-tile-head");
    if (iconName) {
      const ic = dashEl("span", "shadcn-icon");
      ic.style.setProperty(
        "--shadcn-icon",
        `url(${dashMedia()}/icons/${iconName}.svg)`,
      );
      ic.style.setProperty("--shadcn-icon-size", "14px");
      ic.setAttribute("aria-hidden", "true");
      head.appendChild(ic);
    }
    head.appendChild(dashEl("span", "shadcn-dash-tile-label", label));

    const valueRow = dashEl("div", "shadcn-dash-tile-valuerow");
    valueRow.appendChild(dashEl("div", "shadcn-dash-tile-value"));
    valueRow.appendChild(dashEl("span", "shadcn-dash-tile-unit"));

    box.appendChild(head);
    box.appendChild(valueRow);
    box.appendChild(dashEl("div", "shadcn-dash-tile-slot"));
    box.appendChild(dashEl("div", "shadcn-dash-tile-foot"));
    return box;
  }

  function dashSetValue(box, text, unitText) {
    if (!box) return;
    const val = box.querySelector(".shadcn-dash-tile-value");
    const unit = box.querySelector(".shadcn-dash-tile-unit");
    if (val) val.textContent = text;
    if (unit) unit.textContent = unitText ?? "";
  }

  function dashSetFoot(box, text) {
    const foot = box ? box.querySelector(".shadcn-dash-tile-foot") : null;
    if (foot) foot.textContent = text ?? "";
  }

  // 重画槽位内容而不是原地改路径：路径就是几个字符串，重建比 diff 更少出错，
  // 也不可能和数据漂移。
  //
  // 槽位里的图形必须被约束住：带 aspect:true 的 SVG（仪表、环形）会按宽度
  // 撑成正方形，真机上温度仪表因此长到 179px 而槽位只有 34px，直接盖住
  // 磁贴下方的文字。所以这里由槽位统一设死尺寸，图形按 contain 装进去。
  function dashDraw(box, draw) {
    const slot = box ? box.querySelector(".shadcn-dash-tile-slot") : null;
    if (!slot) return;
    slot.textContent = "";
    draw(slot);
    for (const svg of slot.querySelectorAll("svg")) {
      svg.style.width = "100%";
      svg.style.height = "100%";
    }
  }

  function dashSection(key, title, sub) {
    const wrap = dashEl("section", "shadcn-dash-section");
    wrap.id = "shadcn-dash-" + key;

    const head = dashEl("div", "shadcn-dash-section-head");
    head.appendChild(dashEl("h3", "shadcn-dash-section-title", title));
    if (sub) head.appendChild(dashEl("span", "shadcn-dash-section-sub", sub));

    const body = dashEl("div", "shadcn-dash-grid");
    wrap.appendChild(head);
    wrap.appendChild(body);
    return { wrap, body };
  }

  function dashCard(title, key, span) {
    const card = dashEl("div", "shadcn-dash-card");
    card.dataset.card = key;
    if (span) card.classList.add("shadcn-dash-span-2");
    card.appendChild(dashEl("h4", "shadcn-dash-card-title", title));
    const body = dashEl("div", "shadcn-dash-card-body");
    card.appendChild(body);
    return { card, body };
  }

  function dashBuild() {
    const root = dashEl("div", "shadcn-dash");
    root.dataset.state = "loading";

    const bar = dashEl("div", "shadcn-dash-bar");
    const status = dashEl("span", "shadcn-dash-status");
    status.dataset.role = "status";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    bar.appendChild(status);

    const tools = dashEl("div", "shadcn-dash-tools");

    const intervalLabel = dashEl("label", "shadcn-dash-interval");
    intervalLabel.appendChild(dashEl("span", null, "刷新"));
    const select = dashEl("select");
    select.dataset.role = "interval";
    for (const preset of DASH_FAST_PRESETS) {
      const opt = dashEl("option", null, preset + " 秒");
      opt.value = String(preset);
      select.appendChild(opt);
    }
    select.value = String(DASH_DEFAULT_FAST);
    select.addEventListener("change", function () {
      dashIntervalMs = (parseInt(select.value, 10) || DASH_DEFAULT_FAST) * 1000;
      dashRestartFast();
      dashRenderStatus();
    });
    intervalLabel.appendChild(select);
    tools.appendChild(intervalLabel);

    const refresh = dashEl("button", "shadcn-dash-btn", "刷新");
    refresh.type = "button";
    refresh.addEventListener("click", function () {
      dashPaused = false;
      dashTickFast();
      dashTickSlow();
    });
    tools.appendChild(refresh);

    const pause = dashEl("button", "shadcn-dash-btn", "暂停");
    pause.type = "button";
    pause.setAttribute("aria-pressed", "false");
    pause.addEventListener("click", function () {
      dashPaused = !dashPaused;
      pause.textContent = dashPaused ? "继续" : "暂停";
      pause.setAttribute("aria-pressed", dashPaused ? "true" : "false");
      if (dashPaused) dashStopFast();
      else dashRestartFast();
      dashRenderStatus();
    });
    tools.appendChild(pause);

    // 一键诊断：一次性主动检查，跑完即结束。放在逃生口之前，因为它比
    // 「看原生页」更常用。
    const diagnoseBtn = dashEl(
      "button",
      "shadcn-dash-btn shadcn-dash-btn-primary",
      "诊断",
    );
    diagnoseBtn.type = "button";
    diagnoseBtn.dataset.role = "diagnose";
    diagnoseBtn.addEventListener("click", function () {
      dashRunDiagnose(diagnoseBtn);
    });
    tools.appendChild(diagnoseBtn);

    // 逃生口：原生区块还在，只是被隐藏。这条保证「看板坏了也不会让整页
    // 不可用」。
    const native = dashEl("button", "shadcn-dash-btn", "原生概览");
    native.type = "button";
    // 明确标出来供窄屏 CSS 让它跨满整行；不能靠 [aria-pressed] 选，
    // 「暂停」也带这个属性。
    native.dataset.role = "native";
    native.setAttribute("aria-pressed", "false");
    native.addEventListener("click", function () {
      const showing = root.dataset.showNative === "true";
      root.dataset.showNative = showing ? "false" : "true";
      native.setAttribute("aria-pressed", showing ? "false" : "true");
      native.textContent = showing ? "原生概览" : "返回看板";
    });
    tools.appendChild(native);

    bar.appendChild(tools);
    root.appendChild(bar);

    const alerts = dashEl("div", "shadcn-dash-alerts");
    alerts.dataset.role = "alerts";
    root.appendChild(alerts);

    // 诊断结果的落点，与常驻告警区分开：它是「某次检查的结论」，不是
    // 「现在不健康」。默认不占位。
    const diagnoseOut = dashEl("div", "shadcn-dash-diagnose");
    diagnoseOut.dataset.role = "diagnose-out";
    diagnoseOut.hidden = true;
    root.appendChild(diagnoseOut);

    const band = dashEl("div", "shadcn-dash-band");
    band.appendChild(dashTile("wan", "WAN 状态", "network"));
    band.appendChild(dashTile("hosts", "在线终端", "user"));
    band.appendChild(dashTile("conns", "连接总数", "activity"));
    band.appendChild(dashTile("today", "今日总流量", "chart-bar"));
    band.appendChild(dashTile("rate", "实时速率", "gauge"));
    band.appendChild(dashTile("temp", "系统温度", "activity"));
    root.appendChild(band);

    const net = dashSection("net", "线路", "延迟 · 丢包 · 地址");
    const lines = dashCard("每条线路", "lines", true);
    lines.body.classList.add("shadcn-dash-lines");
    net.body.appendChild(lines.card);
    root.appendChild(net.wrap);

    const res = dashSection("res", "资源与运行", "CPU · 内存 · 存储 · 系统");
    const cpu = dashCard("CPU", "cpu");
    res.body.appendChild(cpu.card);
    const mem = dashCard("内存与存储", "mem");
    res.body.appendChild(mem.card);
    // 系统信息：主机名、固件、内核、架构、CPU 型号。这些是静态的，后端读
    // 一次就缓存（probe.uc 的 board()），所以放在这里不增加每分钟开销。
    const sys = dashCard("系统信息", "sys");
    res.body.appendChild(sys.card);
    root.appendChild(res.wrap);

    const flow = dashSection("flow", "流量", "速率 · 排行 · 分布");
    flow.body.appendChild(dashCard("端口实时流量", "ports", true).card);
    flow.body.appendChild(dashCard("今日流量按小时", "hours", true).card);
    flow.body.appendChild(dashCard("Top 主机", "hosts").card);
    flow.body.appendChild(dashCard("协议分布", "protos").card);
    root.appendChild(flow.wrap);

    return root;
  }

  function dashRenderStatus() {
    if (!dashBoard) return;
    const status = dashBoard.querySelector('[data-role="status"]');
    if (!status) return;

    if (dashPaused) {
      status.textContent = "已暂停";
      status.dataset.tone = "muted";
      return;
    }
    if (dashLastError) {
      const age = dashLastOkAt
        ? Math.round((Date.now() - dashLastOkAt) / 1000)
        : null;
      status.textContent =
        "数据已过期" +
        (age != null ? " " + age + " 秒" : "") +
        " · " +
        dashLastError;
      status.dataset.tone = "danger";
      return;
    }
    if (dashDegraded) {
      status.textContent = "已降速（采集耗时过长）";
      status.dataset.tone = "warning";
      return;
    }
    status.textContent = "实时 · 每 " + dashIntervalMs / 1000 + " 秒";
    status.dataset.tone = "ok";
  }

  function dashRenderAlerts(list, thresholds) {
    const box = dashBoard.querySelector('[data-role="alerts"]');
    if (!box) return;
    box.textContent = "";
    if (!list || !list.length) {
      box.hidden = true;
      return;
    }
    box.hidden = false;

    // 有任何一项被 /etc/config/shadcn-dashboard 覆盖时，在横幅尾部标一句，
    // 否则用户改了配置却只能靠猜是否生效。
    const overridden = thresholds
      ? Object.keys(thresholds).filter(function (k) {
          return thresholds[k] && thresholds[k].source === "config";
        })
      : [];

    for (const a of list) {
      const row = dashEl("div", "shadcn-dash-alert");
      row.dataset.tone = a.tone || "warning";
      row.appendChild(dashEl("span", "shadcn-dash-alert-title", a.title));
      if (a.detail)
        row.appendChild(dashEl("span", "shadcn-dash-alert-detail", a.detail));
      // 判定线本身也显示：同一条「温度偏高」在 80 °C 与 70 °C 下含义不同。
      if (a.limit) {
        const lim = dashEl(
          "span",
          "shadcn-dash-alert-limit",
          "阈值 " + a.limit,
        );
        lim.dataset.key = a.key || "";
        row.appendChild(lim);
      }
      box.appendChild(row);
    }

    if (overridden.length) {
      const note = dashEl(
        "div",
        "shadcn-dash-alert-config",
        "阈值来自 /etc/config/shadcn-dashboard：" + overridden.join("、"),
      );
      box.appendChild(note);
    }
  }

  // ── 一键诊断 ─────────────────────────────────────────────────────────
  //
  // 与异常横幅的区别：异常是「现在不健康」，随数据自动出现消失；诊断是
  // 「刚跑了一次检查」，是一次性的结论，不参与刷新。
  //
  // 后端一次跑完网关 / 公网 / DNS 三项并给出逐项结论（实测 38 ms），
  // 所以前端不需要自己 ping —— 也就不需要为「浏览器能不能发 ICMP」
  // 这种做不做得到的事情做降级。

  let dashDiagnosing = false;

  function dashRenderDiagnose(result) {
    const box = dashBoard.querySelector('[data-role="diagnose-out"]');
    if (!box) return;

    box.textContent = "";
    box.hidden = false;

    const head = dashEl("div", "shadcn-dash-diagnose-head");
    const verdict = dashEl(
      "span",
      "shadcn-dash-diagnose-verdict",
      result.verdict || (result.ok ? "全部通过" : "诊断未通过"),
    );
    verdict.dataset.tone = result.ok ? "ok" : "danger";
    head.appendChild(verdict);

    const meta = dashEl("span", "shadcn-dash-diagnose-meta");
    meta.textContent =
      dashClock(result.at) +
      " 执行 · 耗时 " +
      (result.elapsedMs != null ? result.elapsedMs + " ms" : "—");
    head.appendChild(meta);

    const close = dashEl("button", "shadcn-dash-diagnose-close", "关闭");
    close.type = "button";
    close.addEventListener("click", function () {
      box.hidden = true;
      box.textContent = "";
    });
    head.appendChild(close);
    box.appendChild(head);

    const rows = result.checks || [];
    if (!rows.length) {
      // 后端报错时 checks 为空，verdict 里带原因。
      box.appendChild(
        dashEl("p", "shadcn-dash-empty", result.error || "没有可显示的检查项"),
      );
      return;
    }

    const grid = dashEl("div", "shadcn-dash-diagnose-grid");
    for (const c of rows) {
      const row = dashEl("div", "shadcn-dash-diagnose-item");
      row.dataset.tone =
        c.status === "pass" ? "ok" : c.status === "warn" ? "warning" : "danger";

      const dot = dashEl("span", "shadcn-dash-diagnose-dot");
      dot.setAttribute("aria-hidden", "true");
      row.appendChild(dot);

      const label = dashEl("span", "shadcn-dash-diagnose-label", c.label);
      row.appendChild(label);

      const detail = dashEl("span", "shadcn-dash-diagnose-detail");
      // 优先显示测量值；没有测量值时才显示原因。这样「通过」的行是数字，
      // 「未通过」的行是为什么。
      detail.textContent =
        c.value != null
          ? c.value + (c.addrs ? " → " + c.addrs : "")
          : c.error || c.detail || "—";
      row.appendChild(detail);

      grid.appendChild(row);
    }
    box.appendChild(grid);

    // 逐项以外的整体提示：告诉人这次结论会保留到什么时候消失。
    box.appendChild(
      dashEl(
        "p",
        "shadcn-dash-diagnose-note",
        "诊断只反映执行那一刻的状态，不会随看板刷新。网关 " +
          (result.gateway || "未知"),
      ),
    );
  }

  async function dashRunDiagnose(btn) {
    if (dashDiagnosing || !dashBoard) return;
    dashDiagnosing = true;

    const label = btn ? btn.textContent : "";
    if (btn) {
      btn.disabled = true;
      btn.textContent = "诊断中…";
    }

    try {
      if (!dashDiagnoseRpc)
        dashDiagnoseRpc = window.L.require("rpc").then(function (rpc) {
          return rpc.declare({
            object: "shadcn",
            method: "diagnose",
            params: [],
          });
        });

      const call = await dashDiagnoseRpc;
      const result = await call();
      dashRenderDiagnose(result || {});
    } catch (e) {
      // 失败也要有结论可看，不能只留一个按钮变回原样。
      dashRenderDiagnose({
        ok: false,
        at: Math.floor(Date.now() / 1000),
        elapsedMs: null,
        gateway: null,
        checks: [],
        verdict: "诊断请求失败",
        error: String(e && e.message ? e.message : e),
      });
    } finally {
      dashDiagnosing = false;
      if (btn) {
        btn.disabled = false;
        btn.textContent = label || "诊断";
      }
    }
  }

  let dashDiagnoseRpc = null;

  function dashRenderOverview(fast, slow) {
    // WAN 磁贴：用该网口的实时速率判断「有流量」，不谎称链路状态 ——
    // 内核计数只在接口真正收发时才有增量。
    const wanTile = dashBoard.querySelector('[data-tile="wan"]');
    if (wanTile) {
      const rates = fast && fast.net;
      const name = dashWanName();
      const wan = name && rates ? rates[name] : null;
      if (wan && (wan.rx != null || wan.tx != null)) {
        dashSetValue(wanTile, "在线", name);
        dashSetFoot(
          wanTile,
          "↓ " + dashRate(wan.rx) + " · ↑ " + dashRate(wan.tx),
        );
      } else if (name && rates) {
        // 接口存在但拿不到增量：多半是计数器刚复位或本轮没有流量。
        dashSetValue(wanTile, "无数据", name);
        dashSetFoot(wanTile, "本轮无速率增量");
      } else if (rates) {
        dashSetValue(wanTile, "未识别", "");
        dashSetFoot(wanTile, "找不到 WAN 接口");
      } else {
        dashSetValue(wanTile, "—", "");
        dashSetFoot(wanTile, "读取网口失败");
      }
      dashDraw(wanTile, function (slot) {
        ShadcnCharts.sparkline(slot, dashSeries.down.slice(-60), {
          h: 30,
          lineClass: "dash-line",
          areaClass: "dash-area",
        });
      });
    }

    // 在线终端：只有连接表聚合知道有多少个不同 LAN 地址在产生流量。
    const hostTile = dashBoard.querySelector('[data-tile="hosts"]');
    if (hostTile) {
      const conns = slow && slow.conns;
      const n = conns && conns.available ? conns.compact.hosts.length : null;
      dashSetValue(
        hostTile,
        n != null ? String(n) : "—",
        n != null ? "台" : "",
      );
      dashSetFoot(hostTile, n != null ? "按流量聚合" : "连接表不可用");
    }

    const connTile = dashBoard.querySelector('[data-tile="conns"]');
    if (connTile) {
      const ct = fast && fast.conntrack;
      if (ct && ct.available) {
        dashSetValue(connTile, String(ct.count), ct.max ? "/ " + ct.max : "");
        dashSetFoot(
          connTile,
          ct.percent != null ? "占用 " + dashPct(ct.percent) : "上限未知",
        );
        dashDraw(connTile, function (slot) {
          ShadcnCharts.bars(
            slot,
            dashSeries.conns.slice(-40).map(function (v) {
              return { value: v == null ? 0 : v };
            }),
            { h: 30, barClass: "dash-bar" },
          );
        });
      } else {
        dashSetValue(connTile, "—", "");
        dashSetFoot(connTile, ct ? ct.reason : "未启用连接跟踪");
      }
    }

    const todayTile = dashBoard.querySelector('[data-tile="today"]');
    if (todayTile) {
      const hist = slow && slow.history;
      if (hist && hist.available && hist.points.length > 1) {
        let up = 0;
        let down = 0;
        for (let i = 1; i < hist.points.length; i++) {
          const a = hist.points[i - 1].net;
          const b = hist.points[i].net;
          for (const name in b) {
            if (!a[name]) continue;
            const dr = b[name].rx - a[name].rx;
            const dt = b[name].tx - a[name].tx;
            if (dr >= 0) down += dr;
            if (dt >= 0) up += dt;
          }
        }
        dashSetValue(todayTile, dashBytes(up + down), "");
        dashSetFoot(
          todayTile,
          "↑ " +
            dashBytes(up) +
            " · ↓ " +
            dashBytes(down) +
            " · 自 " +
            dashClock(hist.points[0].t),
        );
        // 今日流量按小时的小柱：磁贴里只要一个形状趋势，所以复用同一份
        // 24 桶数据，但不画轴、不画标签。
        dashDraw(todayTile, function (slot) {
          const buckets = dashHourly(hist.points);
          ShadcnCharts.isoBars(
            slot,
            buckets.map(function (b) {
              return { value: b.empty ? null : b.bytes };
            }),
            { w: 100, h: 26, depth: 2 },
          );
        });
      } else {
        dashSetValue(todayTile, "—", "");
        dashSetFoot(todayTile, hist ? hist.reason || "历史不足" : "无历史");
      }
    }

    const rateTile = dashBoard.querySelector('[data-tile="rate"]');
    if (rateTile) {
      const rates = fast && fast.net;
      let up = 0;
      let down = 0;
      let any = false;
      if (rates) {
        for (const name in rates) {
          if (name === "lo") continue;
          if (rates[name].rx != null) {
            down += rates[name].rx;
            any = true;
          }
          if (rates[name].tx != null) up += rates[name].tx;
        }
      }
      dashSetValue(rateTile, any ? dashRate(down) : "—", any ? "↓" : "");
      dashSetFoot(rateTile, any ? "↑ " + dashRate(up) : "待下一轮采样");
      dashDraw(rateTile, function (slot) {
        ShadcnCharts.sparkline(slot, dashSeries.down.slice(-60), {
          h: 30,
          lineClass: "dash-line",
          areaClass: "dash-area",
        });
      });
    }

    const tempTile = dashBoard.querySelector('[data-tile="temp"]');
    if (tempTile) {
      const t = fast && fast.temp;
      if (t && t.available) {
        dashSetValue(tempTile, Math.round(t.max) + " °C", "");
        dashSetFoot(tempTile, t.readings.length + " 个传感器");
        dashDraw(tempTile, function (slot) {
          ShadcnCharts.gauge(slot, t.max, { size: 64, min: 20, max: 100 });
        });
      } else {
        dashSetValue(tempTile, "—", "");
        dashSetFoot(tempTile, t ? t.reason : "不可用");
      }
    }
  }

  function dashRenderLines(fast) {
    const body = dashBoard.querySelector(
      '[data-card="lines"] .shadcn-dash-card-body',
    );
    if (!body) return;
    body.textContent = "";

    const rates = fast && fast.net;
    if (!rates) {
      body.appendChild(dashEl("p", "shadcn-dash-empty", "读取网口失败"));
      return;
    }

    // 跳过 lo 与 ifb 影子接口：都不是运维要看的线路。
    const names = Object.keys(rates).filter(function (n) {
      return !/^(lo|ifb)/.test(n);
    });
    if (!names.length) {
      body.appendChild(dashEl("p", "shadcn-dash-empty", "没有可显示的线路"));
      return;
    }

    for (const name of names) {
      const row = dashEl("div", "shadcn-dash-line");
      row.dataset.line = name;

      const head = dashEl("div", "shadcn-dash-line-head");
      head.appendChild(dashEl("span", "shadcn-dash-line-name", name));

      const live = rates[name].rx != null || rates[name].tx != null;
      const chip = dashEl(
        "span",
        "shadcn-dash-chip",
        live ? "有流量" : "无数据",
      );
      chip.dataset.tone = live ? "ok" : "muted";
      head.appendChild(chip);
      row.appendChild(head);

      const stats = dashEl("div", "shadcn-dash-line-stats");
      stats.appendChild(dashEl("span", null, "↓ " + dashRate(rates[name].rx)));
      stats.appendChild(dashEl("span", null, "↑ " + dashRate(rates[name].tx)));
      row.appendChild(stats);

      body.appendChild(row);
    }
  }

  function dashRenderResources(fast) {
    const cpuBody = dashBoard.querySelector(
      '[data-card="cpu"] .shadcn-dash-card-body',
    );
    if (cpuBody) {
      cpuBody.textContent = "";
      if (fast && fast.cpu != null) {
        const row = dashEl("div", "shadcn-dash-metric-row");
        row.appendChild(dashEl("strong", null, dashPct(fast.cpu)));
        row.appendChild(dashEl("span", "shadcn-dash-muted", "总占用"));
        cpuBody.appendChild(row);

        ShadcnCharts.sparkline(cpuBody, dashSeries.cpu.slice(-60), {
          h: 34,
          lineClass: "dash-line",
          areaClass: "dash-area",
        });

        if (fast.cpuPer && fast.cpuPer.length) {
          const per = dashEl("div", "shadcn-dash-cores");
          for (const v of fast.cpuPer) {
            const cell = dashEl("span", "shadcn-dash-core");
            cell.title = "核 " + v + "%";
            const bar = dashEl("span", "shadcn-dash-core-bar");
            bar.style.height = Math.max(2, Math.min(100, v)) + "%";
            cell.appendChild(bar);
            per.appendChild(cell);
          }
          cpuBody.appendChild(per);
        }
      } else {
        cpuBody.appendChild(
          dashEl(
            "p",
            "shadcn-dash-empty",
            fast ? "CPU 使用率待下一轮采样" : "不可用",
          ),
        );
      }
    }

    const memBody = dashBoard.querySelector(
      '[data-card="mem"] .shadcn-dash-card-body',
    );
    if (memBody) {
      memBody.textContent = "";
      if (fast && fast.mem) {
        const row = dashEl("div", "shadcn-dash-metric-row");
        row.appendChild(dashEl("strong", null, dashPct(fast.mem.percent)));
        row.appendChild(
          dashEl(
            "span",
            "shadcn-dash-muted",
            dashBytes(fast.mem.used) + " / " + dashBytes(fast.mem.total),
          ),
        );
        memBody.appendChild(row);

        const ringWrap = dashEl("div", "shadcn-dash-ring-wrap");
        ShadcnCharts.ring(
          ringWrap,
          [
            {
              value: Math.max(0, 100 - fast.mem.percent),
              class: "dash-ring-free",
            },
            { value: Math.max(0, fast.mem.percent), class: "dash-ring-used" },
          ],
          { size: 72, thickness: 9 },
        );
        memBody.appendChild(ringWrap);

        if (fast.load) {
          const load = dashEl("div", "shadcn-dash-metric-row");
          load.appendChild(dashEl("strong", null, String(fast.load.one)));
          load.appendChild(dashEl("span", "shadcn-dash-muted", "1 分钟负载"));
          memBody.appendChild(load);
        }

        // 运行时长：判断「刚重启过没有」的第一依据，也解释了回看历史为什么
        // 从某个时刻才有数据。读不到时显示「—」，不显示 0（0 秒 = 刚重启，
        // 那是另一种意思）。
        const up = dashEl("div", "shadcn-dash-metric-row");
        up.appendChild(dashEl("strong", null, dashDuration(fast.uptime)));
        up.appendChild(dashEl("span", "shadcn-dash-muted", "运行时长"));
        memBody.appendChild(up);
      } else {
        memBody.appendChild(
          dashEl("p", "shadcn-dash-empty", "读取内存信息失败"),
        );
      }
    }

    // 系统信息卡：内容来自 caps.board（后端读一次即缓存）。
    //
    // 缺字段就跳过那一行，而不是显示空的「—」占位：这份数据只用于识别
    // 「这台机器是什么」，没有缺失某一行也需要提示的意义。
    const sysBody = dashBoard.querySelector(
      '[data-card="sys"] .shadcn-dash-card-body',
    );
    if (sysBody) {
      sysBody.textContent = "";
      const b = dashCaps && dashCaps.board;

      if (!b) {
        sysBody.appendChild(dashEl("p", "shadcn-dash-empty", "系统信息不可用"));
      } else {
        const rows = [
          ["主机名", b.hostname],
          [
            "固件",
            b.distribution && b.version
              ? b.distribution + " " + b.version
              : null,
          ],
          ["内核", b.kernel],
          ["架构", b.target || b.arch],
          ["处理器", b.cpu],
        ];

        for (const [label, value] of rows) {
          if (!value) continue;
          const row = dashEl("div", "shadcn-dash-metric-row");
          const strong = dashEl("strong", null, value);
          // 长值（CPU 型号实测 345px）在窄卡里会被单行省略截断，把完整的
          // 原值放到 title 上，hover 就能看全。
          strong.title = value;
          row.appendChild(strong);
          row.appendChild(dashEl("span", "shadcn-dash-muted", label));
          sysBody.appendChild(row);
        }
      }
    }
  }

  // 把历史按本地小时归桶，补齐 24 根柱子。
  //
  // 只画有采样的小时会让「刚开机」变成两三根铺满半屏的巨型柱（实测两根
  // 时每根 171px 宽，完全读不出是小时图）。固定 24 格之后，缺失的小时
  // 以基线细线呈现，图表的尺度恒定、跨时间可比。
  function dashHourly(points) {
    const byHour = new Map();
    for (let i = 1; i < points.length; i++) {
      const prev = points[i - 1];
      const cur = points[i];
      const hour = new Date(cur.t * 1000).getHours();
      let bytes = 0;
      for (const name in cur.net) {
        const a = prev.net[name];
        if (!a) continue;
        const dr = cur.net[name].rx - a.rx;
        const dt = cur.net[name].tx - a.tx;
        if (dr >= 0) bytes += dr;
        if (dt >= 0) bytes += dt;
      }
      byHour.set(hour, (byHour.get(hour) ?? 0) + bytes);
    }

    const out = [];
    for (let h = 0; h < 24; h++) {
      const bytes = byHour.get(h);
      out.push({
        label: String(h).padStart(2, "0"),
        bytes: bytes ?? 0,
        // 没有采样的小时画成基线细线：它不是「流量为 0」，是「没有数据」。
        empty: bytes == null,
      });
    }
    return out;
  }

  function dashRenderFlow(fast, slow) {
    const portBody = dashBoard.querySelector(
      '[data-card="ports"] .shadcn-dash-card-body',
    );
    if (portBody) {
      portBody.textContent = "";
      const rates = fast && fast.net;
      if (rates) {
        const names = Object.keys(rates).filter(function (n) {
          return n !== "lo";
        });
        if (names.length) {
          const legend = dashEl("div", "shadcn-dash-legend");
          legend.appendChild(dashEl("span", "shadcn-dash-legend-down", "下行"));
          legend.appendChild(dashEl("span", "shadcn-dash-legend-up", "上行"));
          portBody.appendChild(legend);

          ShadcnCharts.sparkline(portBody, dashSeries.down.slice(-90), {
            h: 40,
            lineClass: "dash-line",
            areaClass: "dash-area",
          });
          ShadcnCharts.sparkline(portBody, dashSeries.up.slice(-90), {
            h: 40,
            lineClass: "dash-line-up",
            areaClass: "dash-area-up",
          });

          const list = dashEl("div", "shadcn-dash-portlist");
          for (const n of names) {
            const r = rates[n];
            const row = dashEl("div", "shadcn-dash-portrow");
            row.appendChild(dashEl("span", "shadcn-dash-portname", n));
            row.appendChild(dashEl("span", null, "↓ " + dashRate(r.rx)));
            row.appendChild(dashEl("span", null, "↑ " + dashRate(r.tx)));
            list.appendChild(row);
          }
          portBody.appendChild(list);
        } else {
          portBody.appendChild(
            dashEl("p", "shadcn-dash-empty", "没有可显示的网口"),
          );
        }
      } else {
        portBody.appendChild(dashEl("p", "shadcn-dash-empty", "读取网口失败"));
      }
    }

    const hourBody = dashBoard.querySelector(
      '[data-card="hours"] .shadcn-dash-card-body',
    );
    if (hourBody) {
      hourBody.textContent = "";
      const hist = slow && slow.history;
      if (hist && hist.available && hist.points.length > 1) {
        const buckets = dashHourly(hist.points);
        // 空小时的 value 传 null：isoBars 会跳过它（不画一根 0 高的柱子冒充
        // 「这个小时没有流量」），轴标签仍然占位，所以 24 格的尺度恒定。
        ShadcnCharts.isoBars(
          hourBody,
          buckets.map(function (b) {
            return { value: b.empty ? null : b.bytes };
          }),
          { w: 100, h: 40, depth: 3 },
        );

        const axis = dashEl("div", "shadcn-dash-axis");
        for (const b of buckets)
          axis.appendChild(dashEl("span", null, b.label));
        hourBody.appendChild(axis);
      } else {
        hourBody.appendChild(
          dashEl(
            "p",
            "shadcn-dash-empty",
            hist ? hist.reason || "历史不足（需至少 2 个采样点）" : "无历史",
          ),
        );
      }
    }

    const hostBody = dashBoard.querySelector(
      '[data-card="hosts"] .shadcn-dash-card-body',
    );
    if (hostBody) {
      hostBody.textContent = "";
      const conns = slow && slow.conns;
      if (conns && conns.available && conns.compact.hosts.length) {
        const max = conns.compact.hosts[0].b || 1;
        for (const h of conns.compact.hosts) {
          const row = dashEl("div", "shadcn-dash-rankrow");

          // 下钻进那台主机的实时连接：复用抽屉，只是换一个触发点。
          const label = dashEl("button", "shadcn-dash-rankhost", h.k);
          label.type = "button";
          label.addEventListener("click", function () {
            dashOpenHost(h.k);
          });
          row.appendChild(label);
          row.appendChild(
            dashEl("span", "shadcn-dash-ranksize", dashBytes(h.b)),
          );

          const track = dashEl("div", "shadcn-dash-ranktrack");
          ShadcnCharts.rankBar(track, h.b, max);
          row.appendChild(track);
          hostBody.appendChild(row);
        }
      } else {
        hostBody.appendChild(
          dashEl(
            "p",
            "shadcn-dash-empty",
            conns && conns.error ? conns.error : "暂无排行数据",
          ),
        );
      }
    }

    const protoBody = dashBoard.querySelector(
      '[data-card="protos"] .shadcn-dash-card-body',
    );
    if (protoBody) {
      protoBody.textContent = "";
      const conns = slow && slow.conns;
      if (conns && conns.available && conns.compact.protos.length) {
        const wrap = dashEl("div", "shadcn-dash-ring-wrap");
        ShadcnCharts.ring(
          wrap,
          conns.compact.protos.map(function (p, i) {
            return { value: p.b, class: "dash-ring-s" + (i % 5) };
          }),
          { size: 96, thickness: 16 },
        );
        protoBody.appendChild(wrap);

        const legend = dashEl("div", "shadcn-dash-protolegend");
        for (const p of conns.compact.protos) {
          const row = dashEl("div", "shadcn-dash-protorow");
          row.appendChild(dashEl("span", "shadcn-dash-protoname", p.k));
          row.appendChild(dashEl("span", null, dashBytes(p.b)));
          legend.appendChild(row);
        }
        protoBody.appendChild(legend);
      } else {
        protoBody.appendChild(dashEl("p", "shadcn-dash-empty", "暂无协议数据"));
      }
    }
  }

  function dashPush(arr, value) {
    if (value == null || !isFinite(value)) return;
    arr.push(value);
    if (arr.length > DASH_SERIES_LEN) arr.shift();
  }

  function dashCall(sections) {
    if (!dashRpc)
      dashRpc = window.L.require("rpc").then(function (rpc) {
        return rpc.declare({
          object: "shadcn",
          method: "dashboard",
          params: ["sections"],
        });
      });
    return dashRpc.then(function (call) {
      return call(sections);
    });
  }

  async function dashTickFast() {
    if (dashPaused || dashInflight || !dashBoard) return;
    dashInflight = true;
    const started = Date.now();

    try {
      const data = await dashCall("fast,caps");
      const elapsed = Date.now() - started;

      if (data.caps) dashCaps = data.caps;

      const fast = data.fast;
      if (fast) {
        dashPush(dashSeries.cpu, fast.cpu);
        dashPush(dashSeries.mem, fast.mem ? fast.mem.percent : null);
        dashPush(
          dashSeries.temp,
          fast.temp && fast.temp.available ? fast.temp.max : null,
        );
        dashPush(
          dashSeries.conns,
          fast.conntrack && fast.conntrack.available
            ? fast.conntrack.count
            : null,
        );
        if (fast.net) {
          let up = 0;
          let down = 0;
          for (const name in fast.net) {
            if (name === "lo") continue;
            if (fast.net[name].rx != null) down += fast.net[name].rx;
            if (fast.net[name].tx != null) up += fast.net[name].tx;
          }
          dashPush(dashSeries.up, up);
          dashPush(dashSeries.down, down);
        }
      }

      dashLastError = null;
      dashLastOkAt = Date.now();
      dashBoard.dataset.state = "live";

      // 慢调用说明设备吃力：放宽一档间隔，而不是继续往上堆请求。
      // 阈值是相对当前间隔的（见 dashDegradeThreshold），所以 HTTP 往返
      // 本来就慢的机器不会被误判。
      if (elapsed > dashDegradeThreshold() && !dashDegraded) {
        dashDegraded = true;
        const next = DASH_FAST_PRESETS.find(function (p) {
          return p * 1000 > dashIntervalMs;
        });
        if (next) {
          dashIntervalMs = next * 1000;
          const select = dashBoard.querySelector('[data-role="interval"]');
          if (select) select.value = String(next);
        }
        dashRestartFast();
      } else if (elapsed <= dashDegradeThreshold() && dashDegraded) {
        dashDegraded = false;
      }

      dashRenderOverview(fast, dashSlow);
      dashRenderLines(fast);
      dashRenderResources(fast);
      dashRenderFlow(fast, dashSlow);
      // 告警由后端判定并一起回传（它握有原始数值与 UCI 阈值）；前端只渲染。
      // 后端没给（老版本）时退回空列表，不清空也不假装健康。
      if (data.alerts) dashRenderAlerts(data.alerts, data.thresholds);
      dashRenderStatus();
    } catch (e) {
      dashLastError = String(e && e.message ? e.message : e);
      dashRenderStatus();
    } finally {
      dashInflight = false;
    }
  }

  async function dashTickSlow() {
    if (dashPaused || !dashBoard) return;
    try {
      const data = await dashCall("slow");
      dashSlow = data.slow || null;
      dashRenderOverview(null, dashSlow);
      dashRenderFlow(null, dashSlow);
      // 这里刻意不渲染告警：慢路径只带 slow 数据，后端此刻拿不到 fast 的
      // 内存/温度，会把这些告警判成「已消失」而让横幅闪掉。告警由快路径
      // 统一负责，它的每一轮都同时拥有两侧数据（dashSlow 已缓存）。
    } catch (e) {
      // 慢路径失败不能让看板变空：快路径继续跑，排行卡保留上一帧。
      if (!dashSlow)
        dashSlow = { history: { available: false, reason: "排行不可用" } };
    }
  }

  function dashRestartFast() {
    dashStopFast();
    if (dashPaused) return;
    dashFastTimer = window.setInterval(dashTickFast, dashIntervalMs);
  }

  function dashStopFast() {
    if (dashFastTimer) {
      clearInterval(dashFastTimer);
      dashFastTimer = null;
    }
  }

  // 原生区块的隐藏由 CSS 依据 [data-dashboard="on"] 完成，所以「只在接管
  // 之后隐藏」这条约束由这里设置属性来保证 —— 补丁没跑，属性不存在，
  // 页面就是原生概览。
  function dashEnsure() {
    const view = document.getElementById("view");
    if (!view) return false;
    if (dashBoard && dashBoard.parentElement === view) return true;

    dashBoard = view.querySelector(".shadcn-dash") ?? dashBuild();
    if (!dashBoard.parentElement) view.insertBefore(dashBoard, view.firstChild);

    view.dataset.dashboard = "on";
    return true;
  }

  function dashWatchView() {
    if (dashViewObserver) return;
    dashViewObserver = new MutationObserver(function () {
      const view = document.getElementById("view");
      if (!view) {
        if (dashBoard && !dashBoard.isConnected) dashViewReady = false;
        return;
      }
      if (dashViewReady && dashBoard && dashBoard.parentElement === view)
        return;
      if (dashEnsure()) {
        dashViewReady = true;
        dashTickFast();
        dashTickSlow();
      }
    });
    dashViewObserver.observe(document.body, { childList: true, subtree: true });
  }

  // Top 主机行打开与原生表相同的抽屉。抽屉在本文件里（openDrawer），
  // 所以直接调用，不需要跨补丁事件。
  function dashOpenHost(host) {
    if (!host) return;
    openDrawer(host);
  }

  function dashOnVisibility() {
    if (document.hidden) dashStopFast();
    else if (!dashPaused) {
      dashRestartFast();
      dashTickFast();
    }
  }

  function dashMount() {
    dashWatchView();
    dashEnsure();
    if (dashBoard) {
      dashTickFast();
      dashTickSlow();
    }
    dashRestartFast();
    dashSlowTimer = window.setInterval(dashTickSlow, DASH_SLOW_MS);
    document.addEventListener("visibilitychange", dashOnVisibility);
  }

  function dashUnmount() {
    dashStopFast();
    if (dashSlowTimer) {
      clearInterval(dashSlowTimer);
      dashSlowTimer = null;
    }
    document.removeEventListener("visibilitychange", dashOnVisibility);
    if (dashViewObserver) {
      dashViewObserver.disconnect();
      dashViewObserver = null;
    }
    if (dashBoard) {
      dashBoard.remove();
      dashBoard = null;
    }
    const view = document.getElementById("view");
    if (view) delete view.dataset.dashboard;
    dashViewReady = false;
    for (const k in dashSeries) dashSeries[k].length = 0;
    dashSlow = null;
    dashCaps = null;
    dashLastError = null;
    dashLastOkAt = null;
    dashDegraded = false;
    dashPaused = false;
    dashRpc = null;
    dashDiagnoseRpc = null;
    dashDiagnosing = false;
  }

  // ── drawer ───────────────────────────────────────────────────────────

  const COLUMNS = [
    ["应用", "app"],
    ["协议", "proto"],
    ["线路", "line"],
    ["外网地址", "ext"],
    ["域名", "domain"],
    ["源端口", "sport"],
    ["目的地址", "dst"],
    ["目的端口", "dport"],
    ["上行速率", "up"],
    ["下行速率", "down"],
    ["累计上行", "totalUp"],
    ["累计下行", "totalDown"],
    ["连接状态", "state"],
  ];

  function buildDrawer() {
    const root = el("div", "shadcn-drawer-root");
    root.innerHTML =
      '<div class="shadcn-drawer-mask" data-close></div>' +
      '<aside class="shadcn-drawer" role="dialog" aria-modal="true" aria-labelledby="shadcn-drawer-title">' +
      '  <header class="shadcn-drawer-head">' +
      '    <div class="shadcn-drawer-heading">' +
      '      <span class="shadcn-drawer-kicker">在线主机</span>' +
      '      <h2 id="shadcn-drawer-title" class="shadcn-drawer-title"></h2>' +
      "    </div>" +
      '    <div class="shadcn-drawer-actions">' +
      '      <label class="shadcn-drawer-interval">' +
      "        <span>刷新</span>" +
      "        <select data-interval></select>" +
      "        <span>秒</span>" +
      "      </label>" +
      '      <button type="button" class="shadcn-drawer-close" data-close aria-label="关闭">×</button>' +
      "    </div>" +
      "  </header>" +
      '  <div class="shadcn-drawer-meta" data-meta></div>' +
      '  <div class="shadcn-drawer-body">' +
      '    <table class="shadcn-drawer-table">' +
      "      <thead><tr></tr></thead>" +
      "      <tbody></tbody>" +
      "    </table>" +
      '    <p class="shadcn-drawer-empty" data-empty hidden></p>' +
      "  </div>" +
      "</aside>";

    const theadRow = root.querySelector("thead tr");
    for (const [label] of COLUMNS) {
      const th = el("th", null, label);
      theadRow.appendChild(th);
    }

    const select = root.querySelector("[data-interval]");
    for (const s of INTERVALS) {
      const opt = el("option", null, String(s));
      opt.value = String(s);
      select.appendChild(opt);
    }
    select.value = String(DEFAULT_INTERVAL);
    select.addEventListener("change", function () {
      current.interval = parseInt(select.value, 10) || DEFAULT_INTERVAL;
      restartPolling();
    });

    root.querySelectorAll("[data-close]").forEach(function (n) {
      n.addEventListener("click", closeDrawer);
    });

    document.body.appendChild(root);
    return root;
  }

  function rowFor(c) {
    const tr = el("tr");
    const isLocal = c.src === current.host;
    // 本机发起的连接：对端是 dst；外部连入的：对端是 src
    const peer = isLocal ? c.dst : c.src;

    // 外网地址 = 这条连接的公网侧地址。若对端本身就在内网（例如同网段的
    // 手机访问路由器），这条连接没有“外网地址”，显示 “—”，而不是把
    // 目的地址重复一遍。
    const localNet = lanPrefix;
    const peerIsLan = localNet
      ? !!peer && peer.startsWith(localNet + ".")
      : isPrivateV4(peer);
    const ext = peerIsLan ? "—" : peer;

    const cells = {
      app: c.app ?? "—",
      proto: (c.proto || "").toUpperCase(),
      // 线路 = 这条连接实际走的哪一侧。
      //   内网对端 -> LAN（流量没出路由器）
      //   公网对端 -> WAN（经 WAN 出口）
      // 老写法按“谁发起”判定，于是每一台正常上网的主机都显示 LAN，
      // 即使它的流量明明走的 WAN，这一列因此没有信息量。
      line: peerIsLan ? "LAN" : "WAN",
      ext: ext,
      domain: domainCache.get(peer) ?? "—",
      sport: String(c.sport ?? ""),
      dst: c.dst,
      dport: String(c.dport ?? ""),
      up: fmtRate(c.up),
      down: fmtRate(c.down),
      totalUp: fmtBytes(c.bytes_out),
      totalDown: fmtBytes(c.bytes_in),
      state: c.state || "—",
    };

    for (const [, key] of COLUMNS) {
      const td = el("td", "shadcn-drawer-cell-" + key, String(cells[key]));
      tr.appendChild(td);
    }
    return tr;
  }

  // 把一批地址交给后端反查域名。只问本地已知的（dnsmasq 租约），
  // 查不到就保持空，让表格显示地址本身。
  async function resolveDomains(addrs) {
    const unknown = addrs.filter((a) => a && !domainCache.has(a));
    if (!unknown.length) return;

    try {
      const rpc = await window.L.require("rpc");
      const decl = rpc.declare({
        object: "shadcn",
        method: "resolve",
        params: ["ips"],
      });
      // 逗号分隔的字符串，与后端声明一致
      const res = await decl(unknown.join(","));
      const names = res?.names ?? {};
      for (const [ip, name] of Object.entries(names))
        if (name) domainCache.set(ip, name);
    } catch (e) {
      // 反查失败不影响连接列表：域名列留空即可，不中断刷新
    }
  }

  function renderMeta(data) {
    const meta = drawer.querySelector("[data-meta]");
    if (!meta) return;
    const parts = [];
    if (data.total != null) parts.push("连接 " + data.total + " 条");
    if (data.shown != null && data.total != null && data.shown < data.total)
      parts.push("显示前 " + data.shown + " 条");
    if (!data.sampled) parts.push("首次采样，速率待下一轮");
    meta.textContent = parts.join(" · ");
  }
  async function tick() {
    if (!drawer || !current.host) return;
    const seq = ++current.seq;
    const tbody = drawer.querySelector("tbody");
    const empty = drawer.querySelector("[data-empty]");

    let data;
    try {
      const rpc = await window.L.require("rpc");
      // 位置参数顺序必须与 params 声明一致
      const decl = rpc.declare({
        object: "shadcn",
        method: "connections",
        params: ["ip", "limit"],
      });
      data = await decl(current.host, "300");
    } catch (e) {
      // 失败时保留上一帧，只更新提示，避免表格闪空
      if (empty) {
        empty.hidden = false;
        empty.textContent = "读取连接失败：" + String(e);
      }
      return;
    }

    // 迟到的响应不能覆盖新的主机
    if (seq !== current.seq) return;

    if (!data || data.available === false) {
      if (empty) {
        empty.hidden = false;
        empty.textContent = data?.error
          ? "读取连接失败：" + data.error
          : "暂无数据";
      }
      tbody.textContent = "";
      return;
    }

    renderMeta(data);

    const list = data.connections || [];
    if (!list.length) {
      tbody.textContent = "";
      if (empty) {
        empty.hidden = false;
        empty.textContent = "该主机当前没有活跃连接";
      }
      return;
    }

    if (empty) empty.hidden = true;

    // 后端在返回里带上本机 LAN 网段；“外网地址”列据此区分公网对端与
    // 内网对端。取不到就退回私有地址段判断。
    if (data.lan) lanPrefix = data.lan;

    // 先把表格画出来，再异步补域名：反查不该拖慢首屏，且失败也不影响列表。
    const frag = document.createDocumentFragment();
    for (const c of list) frag.appendChild(rowFor(c));
    tbody.textContent = "";
    tbody.appendChild(frag);

    // 对端地址才是需要反查的（本机地址已在标题里）
    const addrs = [];
    for (const c of list) {
      const ext = c.src === current.host ? c.dst : c.src;
      if (ext) addrs.push(ext);
    }

    const wanted = addrs.filter((a) => !domainCache.has(a));
    if (wanted.length) {
      const hostAtStart = current.host;
      resolveDomains(addrs).then(function () {
        // 期间切换了主机就不要重绘
        if (current.host !== hostAtStart || !drawer) return;
        tbody.textContent = "";
        const again = document.createDocumentFragment();
        for (const c of list) again.appendChild(rowFor(c));
        tbody.appendChild(again);
      });
    }
  }

  function restartPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    if (!drawer || !current.host) return;
    const ms = Math.max(1, current.interval) * 1000;
    pollTimer = window.setInterval(tick, ms);
  }

  function openDrawer(host) {
    if (!drawer) drawer = buildDrawer();
    current.host = host;
    current.seq = 0;

    const title = drawer.querySelector("#shadcn-drawer-title");
    if (title) title.textContent = host;

    drawer.classList.add("is-open");
    document.documentElement.classList.add("shadcn-drawer-lock");

    // 立刻拉一次，不必等满一个间隔
    tick();
    restartPolling();
  }

  function closeDrawer() {
    if (!drawer) return;
    drawer.classList.remove("is-open");
    document.documentElement.classList.remove("shadcn-drawer-lock");
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    current.host = null;
  }

  function onKey(ev) {
    if (ev.key === "Escape") closeDrawer();
  }

  // 点击委托：表格内容由 LuCI 反复重写，逐个绑监听会失效，统一在 document
  // 上派发一次。只认带 data-shadcn-host / data-shadcn-addr 的元素。
  function onClick(ev) {
    // 抽屉自身的点击不处理
    if (ev.target.closest && ev.target.closest(".shadcn-drawer-root")) return;

    const host = hostFromEvent(ev);
    if (!host) return;

    ev.preventDefault();
    openDrawer(host);
  }

  // ── lifecycle ────────────────────────────────────────────────────────

  function mount() {
    watchTable();
    dashMount();
    document.addEventListener("keydown", onKey);
    document.addEventListener("click", onClick);
  }

  function unmount() {
    dashUnmount();
    document.removeEventListener("click", onClick);
    if (enrichObserver) {
      enrichObserver.disconnect();
      enrichObserver = null;
    }
    if (enrichTimer) {
      clearInterval(enrichTimer);
      enrichTimer = null;
    }
    document.removeEventListener("keydown", onKey);
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    if (drawer) {
      drawer.remove();
      drawer = null;
    }
    document.documentElement.classList.remove("shadcn-drawer-lock");
    current = { host: null, interval: DEFAULT_INTERVAL, seq: 0 };
  }

  // 页面范围的生命周期，供客户端路由调用；整页加载时直接挂载一次。
  (window.luciPatches ??= {})[PATCH] = { mount, unmount };
  mount();
})();
