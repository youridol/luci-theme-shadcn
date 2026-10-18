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
  const PATCH = "admin-status-overview-detail";

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

  const SERIES_LEN = 40;

  // 采样间隔。与 LuCI 的 pollinterval（5s）一致：读取的是它已经刷新的
  // 内容，比它更勤只会重复读到同一批数字。
  const SAMPLE_MS = 5000;

  const series = {
    cpu: [],
    wan: [],
  };

  let metrics = null;
  let sampleTimer = null;
  let viewObserver = null;
  // 当前这份 `#view` 是否已经挂好指标带。观察器靠它判断「首次出现/被重建」，
  // 从而不会因为自己写 DOM 把回调再次触发。
  let viewReady = false;
  // 上一次的网口累计字节数与对应的采样时刻，用于算瞬时总速率。
  // 时间戳必须和计数一起存：两次采样之间的真实间隔随定时器抖动，
  // 按固定的 5s 去除会把速率算错。
  let lastIfBytes = null;

  // 页面里某个区块的键值表读成 map。区块按标题定位 —— 表格本身没有 id，
  // 而标题是 LuCI 稳定输出的。
  function sectionTable(title) {
    const mc = document.querySelector("#maincontent");
    if (!mc) return null;

    for (const sec of mc.querySelectorAll(".cbi-section")) {
      const h = sec.querySelector("h3, h2, legend");
      if (!h || (h.textContent || "").trim().replace(/隐藏$/, "") !== title)
        continue;
      return sec.querySelector("table.table") ?? sec.querySelector("table");
    }

    return null;
  }

  function readPairs(table) {
    const out = {};
    if (!table) return out;

    for (const tr of table.querySelectorAll("tr")) {
      const cells = tr.querySelectorAll("td");
      if (cells.length < 2) continue;
      const k = (cells[0].textContent || "").trim();
      const v = cells[1];
      if (k) out[k] = v;
    }

    return out;
  }

  // 从进度条的 title 里取「已用 / 总量 (百分比)」。LuCI 把三个数都放在
  // title 上，是这里唯一不靠猜的来源。
  function parseProgress(cell) {
    const bar = cell && cell.querySelector(".cbi-progressbar");
    if (!bar) return null;

    const m = /^(.+?)\s*\/\s*(.+?)\s*\(([\d.]+)%\)$/.exec(
      (bar.getAttribute("title") || "").trim(),
    );
    if (!m) return null;

    return { used: m[1], total: m[2], pct: parseFloat(m[3]) };
  }

  // 网口累计收发字节。表里没有这个数，只有 tooltip 里的「已接收字节数:
  // 9.02 GiB」这类字符串，所以按单位解析回字节再相加，跨网口求总速率。
  const UNITS = {
    B: 1,
    KB: 1e3,
    KiB: 1024,
    MB: 1e6,
    MiB: 1024 ** 2,
    GB: 1e9,
    GiB: 1024 ** 3,
    TB: 1e12,
    TiB: 1024 ** 4,
  };

  function parseBytes(text) {
    if (!text) return null;
    const m = /([\d.]+)\s*(B|KB|KiB|MB|MiB|GB|GiB|TB|TiB)/.exec(text);
    if (!m) return null;
    const n = parseFloat(m[1]);
    if (!isFinite(n)) return null;
    return n * (UNITS[m[2]] ?? 1);
  }

  function portTotals() {
    const mc = document.querySelector("#maincontent");
    if (!mc) return null;

    let rx = 0;
    let tx = 0;
    let found = false;

    // 每个网口卡里都有两个 .cbi-tooltip：外层是「属于以下网络」，内层才是
    // 收发计数。按最近一次的匹配取，而不是只看每张卡的第一个 tooltip ——
    // 否则只会读到网络归属那一段，永远解析不到字节数。
    for (const box of mc.querySelectorAll(".ifacebox")) {
      const text = (box.textContent || "").replace(/\s+/g, " ");
      const r = /已接收字节数\s*:\s*([\d.]+\s*[A-Za-z]+)/.exec(text);
      const t = /已发送字节数\s*:\s*([\d.]+\s*[A-Za-z]+)/.exec(text);
      if (!r && !t) continue;
      found = true;
      rx += (r ? parseBytes(r[1]) : 0) ?? 0;
      tx += (t ? parseBytes(t[1]) : 0) ?? 0;
    }

    return found ? { rx, tx } : null;
  }

  function push(seriesRef, value) {
    if (value == null || !isFinite(value)) return;
    seriesRef.push(value);
    if (seriesRef.length > SERIES_LEN) seriesRef.shift();
  }

  // 平滑成折线。只有一个样本时画一条水平基线：磁贴的折线区高度是固定的，
  // 首轮缺一条线会让整排磁贴高低不齐。
  function sparkPath(values, w, h) {
    if (!values || !values.length) return null;

    if (values.length === 1) {
      const y = (h / 2).toFixed(1);
      return {
        line: `M0 ${y} L${w} ${y}`,
        area: `M0 ${y} L${w} ${y} L${w} ${h} L0 ${h} Z`,
      };
    }

    let min = Math.min(...values);
    let max = Math.max(...values);
    // 全等序列（例如 CPU 一直是 0%）会得到零高度，给一个人为的跨度让它
    // 落在中线附近，而不是贴着底边。
    if (max - min < 1e-9) {
      const c = min;
      min = c - 1;
      max = c + 1;
    }

    const step = w / (values.length - 1);
    const pts = values.map((v, i) => {
      const x = i * step;
      const y = h - ((v - min) / (max - min)) * h;
      return [x, y];
    });

    const line = pts
      .map(([x, y], i) => (i ? "L" : "M") + x.toFixed(1) + " " + y.toFixed(1))
      .join(" ");
    const area = line + " L" + w.toFixed(1) + " " + h + " L0 " + h + " Z";

    return { line, area };
  }

  function svgNode(paths) {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("class", "shadcn-spark");
    svg.setAttribute("viewBox", "0 0 100 34");
    svg.setAttribute("preserveAspectRatio", "none");
    svg.setAttribute("aria-hidden", "true");

    for (const [d, cls] of [
      [paths.area, "shadcn-spark-area"],
      [paths.line, "shadcn-spark-line"],
    ]) {
      const p = document.createElementNS(ns, "path");
      p.setAttribute("d", d);
      p.setAttribute("class", cls);
      svg.appendChild(p);
    }

    return svg;
  }

  // 图标只有四个，直接内联，避免为一处磁贴额外发一次请求。
  const ICONS = {
    clock:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
    cpu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/></svg>',
    memory:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="20" height="10" rx="2"/><path d="M6 7v10M10 7v10M14 7v10M18 7v10"/></svg>',
    traffic:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17l5-6 4 4 4-6 5 5"/><path d="M3 21h18"/></svg>',
  };

  // 一个磁贴。value/foot 之后由 updateMetric 填，避免整块重建时丢掉折线。
  //
  // 槽位（.shadcn-metric-slot）从一开始就在：折线、进度条都插进它内部，
  // 磁贴因此在“只有占位”和“已有图形”两种状态下高度一致，数据到达时不会
  // 把整条指标带撑高、进而把下面的区块推下去。
  function tile(key, icon, label) {
    const box = el("div", "shadcn-metric");
    box.dataset.metric = key;

    const head = el("div", "shadcn-metric-head");
    const ic = el("span", "shadcn-metric-icon");
    ic.innerHTML = ICONS[icon];
    head.appendChild(ic);
    head.appendChild(el("span", null, label));

    const val = el("div", "shadcn-metric-value");
    const slot = el("div", "shadcn-metric-slot");
    const foot = el("div", "shadcn-metric-foot");

    box.appendChild(head);
    box.appendChild(val);
    box.appendChild(slot);
    box.appendChild(foot);
    return box;
  }

  function slotOf(box) {
    return box.querySelector(".shadcn-metric-slot");
  }

  function setValue(box, text, unit) {
    const val = box.querySelector(".shadcn-metric-value");
    if (!val) return;
    val.textContent = text;
    if (unit) {
      const u = el("span", "shadcn-metric-unit", unit);
      val.appendChild(u);
    }
  }

  function setFoot(box, text) {
    const foot = box.querySelector(".shadcn-metric-foot");
    if (foot) foot.textContent = text;
  }

  // 折线每次重建：路径就是两个字符串，重建比原地改 d 更少出错。
  // 图形一律放进槽位，槽位本身始终存在，磁贴高度因此不随图形有无而变化。
  function setSpark(box, values) {
    const slot = slotOf(box);
    if (!slot) return;

    const old = slot.querySelector(".shadcn-spark");
    if (old) old.remove();

    const paths = sparkPath(values, 100, 34);
    if (!paths) return;
    slot.appendChild(svgNode(paths));
  }

  function setMeter(box, pct) {
    const slot = slotOf(box);
    if (!slot) return;

    let meter = slot.querySelector(".shadcn-meter");
    if (!meter) {
      meter = el("div", "shadcn-meter");
      meter.appendChild(el("span"));
      slot.appendChild(meter);
    }
    const fill = meter.firstElementChild;
    if (fill) fill.style.width = Math.max(0, Math.min(100, pct || 0)) + "%";
  }

  function buildMetrics() {
    const band = el("div", "shadcn-metrics");
    band.appendChild(tile("uptime", "clock", "运行时间"));
    band.appendChild(tile("load", "cpu", "系统负载"));
    band.appendChild(tile("memory", "memory", "内存占用"));
    band.appendChild(tile("traffic", "traffic", "WAN 流量"));
    return band;
  }

  // 把页面上的数字搬进磁贴。数据缺失时如实显示 “—”，不留占位假值。
  //
  // 磁贴现在在 `#view` 出现的第一刻就插入，那一刻区块里的表格往往还没渲染。
  // 这种情况下只画骨架、不往折线里塞 null —— 把「尚未就绪」当成一次 0 采样
  // 会让折线凭空多一个谷底，而那并不是观测到的值。
  function updateMetrics() {
    if (!metrics || !metrics.isConnected) return;

    const sys = readPairs(sectionTable("系统"));
    const mem = readPairs(sectionTable("内存"));

    const uptimeCell = sys["运行时间"];
    const uptimeText = uptimeCell ? (uptimeCell.textContent || "").trim() : "";
    const loadCell = sys["平均负载"];
    const loadText = loadCell ? (loadCell.textContent || "").trim() : "";
    const cpuCell = sys["CPU 使用率（%）"];
    const cpuText = cpuCell ? (cpuCell.textContent || "").trim() : "";

    // 系统表还没出来：磁贴先留着标题与占位，等下一轮（观察器或采样）再填。
    const sysReady = !!uptimeText;

    // 运行时间
    const uptime = metrics.querySelector('[data-metric="uptime"]');
    if (uptime) {
      setValue(uptime, uptimeText || "—");
      setFoot(
        uptime,
        (sys["主机名"] ? (sys["主机名"].textContent || "").trim() : "") ||
          "本机",
      );
    }

    // 负载 + CPU 折线
    const cpuNow = parseFloat(cpuText);
    if (sysReady) push(series.cpu, isFinite(cpuNow) ? cpuNow : null);

    const loadBox = metrics.querySelector('[data-metric="load"]');
    if (loadBox) {
      const first = loadText.split(",")[0] || "—";
      const cores =
        (sys["架构"] ? sys["架构"].textContent || "" : "").match(
          /(\d+)C/,
        )?.[1] ?? null;
      setValue(loadBox, first.trim(), cores ? "/ " + cores + " 核" : "");
      setFoot(
        loadBox,
        "CPU " +
          (cpuText || "—") +
          (loadText ? " · 1/5/15 分钟 " + loadText : ""),
      );
      setSpark(loadBox, series.cpu);
    }

    // 内存
    const memBox = metrics.querySelector('[data-metric="memory"]');
    if (memBox) {
      const avail = parseProgress(mem["可用数"]);
      if (avail) {
        setValue(memBox, avail.pct.toFixed(0) + "%", "已用");
        setFoot(memBox, avail.used + " / " + avail.total);
        setMeter(memBox, avail.pct);
      } else {
        setValue(memBox, "—");
        setFoot(memBox, "读取内存信息失败");
        setMeter(memBox, 0);
      }
    }

    // WAN 流量：按两次采样的累计字节差求总速率
    const now = portTotals();
    const traffic = metrics.querySelector('[data-metric="traffic"]');
    if (traffic) {
      const at = Date.now();
      if (now && lastIfBytes && lastIfBytes.at) {
        const dt = (at - lastIfBytes.at) / 1000;
        const dUp = now.tx - lastIfBytes.tx;
        const dDown = now.rx - lastIfBytes.rx;
        // 累计值回落说明计数器被重置（网口重连），这一轮速率不可信
        const up = dUp >= 0 && dt > 0 ? dUp / dt : null;
        const down = dDown >= 0 && dt > 0 ? dDown / dt : null;
        if (up != null && down != null) push(series.wan, up + down);
        setValue(traffic, fmtRate(down), "↓");
        setFoot(
          traffic,
          "↑ " +
            fmtRate(up) +
            " · 累计 " +
            fmtBytes(now.rx) +
            " / " +
            fmtBytes(now.tx),
        );
      } else if (now) {
        // 计数器已可读但还没有上一轮可比：本轮的数据就是基线，下一轮起
        // 才有速率。这里不猜一个比值，如实说明。
        setValue(traffic, "—", "↓");
        setFoot(
          traffic,
          "累计 " +
            fmtBytes(now.rx) +
            " / " +
            fmtBytes(now.tx) +
            "，速率待下一轮",
        );
      } else {
        setValue(traffic, "—");
        setFoot(traffic, "读取网口计数失败");
      }
      if (now) lastIfBytes = { rx: now.rx, tx: now.tx, at };
      setSpark(traffic, series.wan);
    }
  }

  // 指标带插在第一个区块之前。
  //
  // 这里不能只靠采样定时器：LuCI 的 `#view` 是异步渲染的，脚本求值时它还不
  // 存在，于是磁贴只能等下一个 5s 采样周期才出现 —— 用户看到的是「区块先
  // 出来、卡片过几秒才补上」。
  //
  // 但也不能一见到 `#view` 就插：`#view` 先是只含一个 `.spinning` 占位
  // （「正在载入视图...」），真正的内容随后才替换进来。那时插入的磁贴正处在
  // 250ms 淡入的起点、opacity 为 0，视觉上仍是一段空白。所以等首个
  // `.cbi-section` 出现再插，卡片与区块同一帧、同一条淡入曲线浮现。
  function ensureMetrics() {
    const view = document.getElementById("view");
    if (!view) return false;

    // 还没渲染出真实内容：保持等待，不插入空壳
    if (!view.querySelector(".cbi-section")) return false;

    if (metrics && metrics.parentElement === view) return true;

    // 页面重绘会留下上一轮的节点，优先复用，避免重复插入
    metrics = view.querySelector(".shadcn-metrics") ?? buildMetrics();
    if (!metrics.parentElement) view.insertBefore(metrics, view.firstChild);

    return true;
  }

  // 盯着 `#view` 的出现与重建。
  //
  // updateMetrics() 自己会写 DOM（数值、折线、进度条），而这里观察的是整份
  // 文档的 subtree —— 不设闩的话，每次写入都会再触发一次回调，形成自激。
  // `viewReady` 记住「已经为当前这份 #view 挂好指标带」，只有它从无到有
  // （#view 首次出现，或被 LuCI 重建）时才继续往下走。
  function watchView() {
    if (viewObserver) return;

    viewObserver = new MutationObserver(function () {
      const view = document.getElementById("view");
      if (!view) {
        // #view 被移除：下次重建要重新插入
        if (metrics && !metrics.isConnected) viewReady = false;
        return;
      }

      if (viewReady && metrics && metrics.parentElement === view) return;

      if (ensureMetrics()) {
        viewReady = true;
        updateMetrics();
      }
    });

    viewObserver.observe(document.body, { childList: true, subtree: true });
  }

  // 一轮采样：先确保磁贴在页面上，再更新数字。
  function sampleTick() {
    if (ensureMetrics()) {
      viewReady = true;
      updateMetrics();
    }
  }

  function startSampling() {
    if (sampleTimer) return;
    sampleTimer = window.setInterval(sampleTick, SAMPLE_MS);
  }

  function stopSampling() {
    if (!sampleTimer) return;
    clearInterval(sampleTimer);
    sampleTimer = null;
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
    // 先挂观察器，再补一次直接检查：`#view` 若已在页面上（路由跳转回来），
    // 立刻就有卡片；若还没渲染，观察器会在它出现的同一刻插入。
    watchView();
    sampleTick();
    startSampling();
    document.addEventListener("keydown", onKey);
    document.addEventListener("click", onClick);
  }

  function unmount() {
    document.removeEventListener("click", onClick);
    if (viewObserver) {
      viewObserver.disconnect();
      viewObserver = null;
    }
    if (enrichObserver) {
      enrichObserver.disconnect();
      enrichObserver = null;
    }
    if (enrichTimer) {
      clearInterval(enrichTimer);
      enrichTimer = null;
    }
    document.removeEventListener("keydown", onKey);
    stopSampling();
    if (metrics) {
      metrics.remove();
      metrics = null;
    }
    viewReady = false;
    series.cpu.length = 0;
    series.wan.length = 0;
    lastIfBytes = null;
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
