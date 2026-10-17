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
    if (n < 1024) return (n >= 10 ? Math.round(n) : Math.round(n * 10) / 10) + " B/s";
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
    const re = pattern === "v4"
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
    const row =
      table.querySelector("thead tr") ?? table.querySelector("tr");
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
      '        <select data-interval></select>' +
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
        empty.textContent = data?.error ? "读取连接失败：" + data.error : "暂无数据";
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
    document.addEventListener("keydown", onKey);
    document.addEventListener("click", onClick);
  }

  function unmount() {
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
