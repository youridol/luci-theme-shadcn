"use strict";

/* 声明成 LuCI 模块。这行不是随便写的注释：构建时把带 `require` 声明的文件
   按模块处理（允许顶层 return），与 sidebar-shadcn.js 的做法一致；缺了它，
   末尾的顶层 return 在脚本模式下是语法错误，terser 会直接报
   `Unexpected token: punc (})` 并跳过这个文件，产物里就没有 table-sort.js。 */
"require baseclass";

/* ── 这个文件为什么长这样 ───────────────────────────────────────────────────

   它是通过 L.require('table-sort') 加载的 LuCI 模块，而 LuCI 的 require 期望
   模块求值后**返回一个 baseclass 派生类**。判定在 luci.js 里只有一句：

     if (!Class.isSubclass(_class))
         LuCI.prototype.error('TypeError',
             '"%s" factory yields invalid constructor', name);

   而 `Class.isSubclass(v)` 的实现是
   `typeof v === 'function' && v.prototype instanceof Class`。所以**光返回一个
   函数不够** —— 必须是 baseclass 的派生类。上一版返回裸的
   `function tableSort() {}`，函数是函数，但 prototype 不继承 baseclass，于是
   控制台报 `"table-sort" factory yields invalid constructor`，并打断同一页后
   续的脚本。

   现在改成 `return baseclass.extend({ __init__() { … } })`，与同目录的
   sidebar-shadcn.js、router-shadcn.js 一致。

   顶层 `return` 只有在模块体里才合法，本仓库的构建按 LuCI 模块处理这类文件，
   打包时不会报错。

   ── 先读这段，避免重造轮子 ────────────────────────────────────────────────

   LuCI 自己就有表头点击排序，实现在 ui.js 的 UIDataTable 里：
     · 表头行 tr.table-titles 上挂着 handleSort 监听（不是每个 th 各挂一个）；
     · 列上写 data-sortable-row="true"，当前列写 data-sort-direction；
     · handleSort 负责切换方向、清掉其它列的箭头、重排 this.data 并 update()；
     · setActiveSortState 还会把「哪一列、什么方向」存进 sessionStorage 的
       `tablesort`（键是 `页面.datatable-id`），刷新页面后自动恢复。

   第一版这份脚本又实现了一遍表头排序，结果是**和 LuCI 抢同一个属性**：一次
   点击 LuCI 先把方向写成 asc，本脚本读到 asc 便写成 desc，用户看到的是
   「第一次点就是降序、再点没反应」。真机上给 setAttribute 打桩能看到两次
   写入，堆栈分别来自 ui.js 和本文件。

   所以表头排序一律交给 LuCI，本文件不碰 data-sortable-row /
   data-sort-direction。这里只补 LuCI 覆盖不到的两种表：

   1. 表格只有一列、或表头是空的 —— handleSort 需要点到带
      data-sortable-row 的 th 才生效，没有可点的表头时它什么也不做。
   2. 表格不是 UIDataTable 渲染的（静态 HTML 表格）—— 这类表没有 LuCI 的
      实例，也就没有排序。

   对这两种表，在表格上方插一个「排序」按钮，点开是「列 + 方向」的列表。
*/

function startTableSort() {
  var DONE_ATTR = "data-shadcn-sortmenu";

  // ── 值解析 ──────────────────────────────────────────────────────────────

  /* 把单元格文本猜成可比较的键。{ t: 类型秩, v: 值 }
     类型秩让「数字 < IP < 状态词 < 文本」有确定次序，不靠隐式转换碰运气。 */
  function parseCell(text) {
    var s = (text || "").trim();

    if (s === "" || s === "-" || s === "—") return { t: 3, v: 0 };

    // 容量：12.3 MB / 900 KB。换算成字节，否则按文本比会得出「900 KB > 1.2 MB」。
    var m = s.match(/^([\d.]+)\s*([KMGTP]?i?B)(?:\/s)?$/i);
    if (m) {
      var units = ["B", "KB", "MB", "GB", "TB", "PB"];
      var unit = m[2].toUpperCase().replace("IB", "B");
      var idx = units.indexOf(unit);
      var scale = /i/i.test(m[2])
        ? Math.pow(1024, idx < 0 ? 0 : idx)
        : Math.pow(1000, idx < 0 ? 0 : idx);
      return { t: 0, v: parseFloat(m[1]) * scale };
    }

    // 纯数字（含千分位与百分号）。
    var n = s.replace(/,/g, "").replace(/%$/, "");
    if (/^[-+]?\d+(\.\d+)?$/.test(n)) return { t: 0, v: parseFloat(n) };

    // 时长：1 天 4 小时 → 秒。
    var dur = 0;
    var hit = false;
    var day = s.match(/(\d+)\s*天/);
    var hr = s.match(/(\d+)\s*(?:小时|h)/i);
    var min = s.match(/(\d+)\s*(?:分钟|min)/i);
    var sec = s.match(/(\d+)\s*秒/);
    if (day) {
      dur += +day[1] * 86400;
      hit = true;
    }
    if (hr) {
      dur += +hr[1] * 3600;
      hit = true;
    }
    if (min) {
      dur += +min[1] * 60;
      hit = true;
    }
    if (sec) {
      dur += +sec[1];
      hit = true;
    }
    if (hit) return { t: 0, v: dur };

    // IPv4：按数值比，避免 .9 排到 .10 后面。
    var ip = s.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (ip)
      return {
        t: 1,
        v: (+ip[1] << 24) + (+ip[2] << 16) + (+ip[3] << 8) + +ip[4],
      };

    // 状态词给固定次序。
    var order = {
      在线: 2,
      有流量: 2,
      已连接: 2,
      正常: 2,
      已启用: 2,
      离线: 0,
      未连接: 0,
      无流量: 0,
      已停用: 0,
    };
    if (Object.prototype.hasOwnProperty.call(order, s))
      return { t: 2, v: order[s] };

    return { t: 3, v: s.toLowerCase() };
  }

  function compareCells(a, b) {
    var ra = parseCell(a);
    var rb = parseCell(b);

    // 空值永远沉底。
    if (ra.t === 3 && ra.v === 0) return 1;
    if (rb.t === 3 && rb.v === 0) return -1;

    if (ra.t !== rb.t) return ra.t - rb.t;
    if (ra.v < rb.v) return -1;
    if (ra.v > rb.v) return 1;
    return 0;
  }

  // ── 行与表头 ────────────────────────────────────────────────────────────

  /* 数据行。
     注意 LuCI 的表常常把 <tr> 直接挂在 <table> 下，没有 <tbody>（连接页实测
     204 行都是 table 的直接子元素，tBodies.length 为 0），所以两种形态都支持。 */
  function bodyRows(table) {
    var container = (table.tBodies && table.tBodies[0]) || table;
    var out = [];

    for (var i = 0; i < container.children.length; i++) {
      var r = container.children[i];
      if (r.tagName !== "TR") continue;
      if (r.classList.contains("table-titles")) continue;
      if (r.classList.contains("cbi-section-table-titles")) continue;
      if (r.classList.contains("cbi-section-table-descr")) continue;
      if (r.classList.contains("placeholder")) continue;
      if (!r.children.length) continue;
      out.push(r);
    }

    return out;
  }

  function headerCells(table) {
    var trs = table.querySelectorAll("tr");
    for (var i = 0; i < trs.length; i++) {
      if (
        trs[i].classList.contains("table-titles") ||
        trs[i].classList.contains("cbi-section-table-titles")
      ) {
        return trs[i];
      }
    }
    var thead = table.tHead;
    return thead && thead.rows.length
      ? thead.rows[thead.rows.length - 1]
      : null;
  }

  function sortBy(table, colIndex, dir) {
    var rows = bodyRows(table);
    if (rows.length < 2) return;

    var container = (table.tBodies && table.tBodies[0]) || table;

    rows.sort(function (a, b) {
      var ca = a.children[colIndex];
      var cb = b.children[colIndex];
      if (!ca || !cb) return 0;
      var r = compareCells(ca.textContent, cb.textContent);
      return dir === "desc" ? -r : r;
    });

    // 只移动节点：行上的监听器跟着走，不会失效。
    var frag = document.createDocumentFragment();
    for (var i = 0; i < rows.length; i++) frag.appendChild(rows[i]);
    container.appendChild(frag);
  }

  // ── 排序菜单 ────────────────────────────────────────────────────────────

  /* LuCI 是否已经给这张表提供了点击排序。
     判据是「表头里有没有带 data-sortable-row 的单元格」—— 那正是 ui.js 的
     handleSort 要求的锚点。有就交给它，本文件不重复实现。 */
  function luciHandlesSort(table) {
    return table.querySelector('th[data-sortable-row="true"]') != null;
  }

  /* 这张表值不值得排序。

     实测踩到的误判：实时信息页的统计汇总表（UDP / TCP / 其它，三行六列）被
     加了排序菜单，但它既没有表头也无可推断的列名，菜单里只能显示「第 1 列
     ↑」…「第 6 列 ↓」这种对用户毫无意义的条目。这类表是「读数面板」而不是
     列表，不该给排序。

     三条判据：
       · 至少 3 个数据行 —— 两行排序没有意义；
       · 能推出至少两个列名 —— 全推不出来说明这是无表头的读数面板；
       · 不是统计汇总（行首是「XX：」这种带冒号的固定标签）。 */
  function worthSorting(table, rows, labels) {
    if (rows.length < 3) return false;

    var named = 0;
    for (var i = 0; i < labels.length; i++)
      if (labels[i] && labels[i].indexOf("第 ") !== 0) named++;
    if (named < 2) return false;

    // 统计汇总表：每行第一格形如「UDP：」「TCP：」。
    var summary = 0;
    for (var j = 0; j < rows.length; j++) {
      var first = rows[j].children[0];
      if (first && /[：:]\s*$/.test((first.textContent || "").trim()))
        summary++;
    }
    if (summary === rows.length) return false;

    return true;
  }

  function addSortMenu(table) {
    if (
      table.previousElementSibling &&
      table.previousElementSibling.classList &&
      table.previousElementSibling.classList.contains("shadcn-sort-menu")
    )
      return;

    var rows = bodyRows(table);
    if (rows.length < 3) return;

    var head = headerCells(table);

    /* 列名从三处推，按可信度排：表头文本 → 单元格的 data-title（LuCI 在
       移动端折叠时写它当列名）→ 「第 N 列」。三处都推不出来的表由
       worthSorting 挡掉，不会建出满是「第 N 列」的菜单。 */
    var first = rows[0];
    var options = [];

    for (var i = 0; i < first.children.length; i++) {
      var cell = first.children[i];
      var hc = head && head.children[i];
      var label = hc ? (hc.textContent || "").trim() : "";

      if (!label) label = (cell.getAttribute("data-title") || "").trim();
      if (!label) label = "第 " + (i + 1) + " 列";

      options.push({ idx: i, label: label });
    }

    if (!options.length) return;

    // 读数面板 / 统计汇总表不建菜单（见 worthSorting 的说明）。
    if (
      !worthSorting(
        table,
        rows,
        options.map(function (o) {
          return o.label;
        }),
      )
    )
      return;

    var bar = document.createElement("div");
    bar.className = "shadcn-sort-menu";

    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "shadcn-sort-menu-btn";
    btn.setAttribute("aria-haspopup", "true");
    btn.setAttribute("aria-expanded", "false");
    btn.textContent = "排序";

    var list = document.createElement("div");
    list.className = "shadcn-sort-menu-list";
    list.hidden = true;
    list.setAttribute("role", "menu");

    options.forEach(function (o) {
      ["asc", "desc"].forEach(function (dir) {
        var item = document.createElement("button");
        item.type = "button";
        item.className = "shadcn-sort-menu-item";
        item.setAttribute("role", "menuitem");
        item.textContent = o.label + (dir === "asc" ? " ↑" : " ↓");

        item.addEventListener("click", function (e) {
          e.stopPropagation();
          sortBy(table, o.idx, dir);
          list.hidden = true;
          btn.setAttribute("aria-expanded", "false");
          btn.textContent = "排序 · " + o.label + (dir === "asc" ? " ↑" : " ↓");
        });

        list.appendChild(item);
      });
    });

    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      var open = list.hidden;
      list.hidden = !open;
      btn.setAttribute("aria-expanded", open ? "true" : "false");
    });

    // 点外面收起，和主题里其它弹出层一致。
    document.addEventListener("click", function () {
      if (!list.hidden) {
        list.hidden = true;
        btn.setAttribute("aria-expanded", "false");
      }
    });

    bar.appendChild(btn);
    bar.appendChild(list);
    table.parentNode.insertBefore(bar, table);

    table.setAttribute(DONE_ATTR, "1");
  }

  // ── 调度 ────────────────────────────────────────────────────────────────

  function scan() {
    var tables = document.querySelectorAll("table.table, .table");

    for (var i = 0; i < tables.length; i++) {
      var t = tables[i];

      // 嵌套表格只处理最外层。
      if (t.parentNode && t.parentNode.closest("table.table, .table")) continue;

      // LuCI 已经接管排序的表跳过 —— 这是本文件唯一的改动原则。
      if (luciHandlesSort(t)) continue;

      if (t.getAttribute(DONE_ATTR) === "1") continue;

      try {
        addSortMenu(t);
      } catch (e) {
        /* 单张表出错不影响其它表。 */
      }
    }
  }

  var timer = null;

  function schedule() {
    if (timer) return;
    timer = window.setTimeout(function () {
      timer = null;
      scan();
    }, 150);
  }

  function start() {
    scan();

    /* LuCI 重写表格时可能连我们插的菜单一起冲掉（它是整块 innerHTML 替换），
       所以盯着新增节点补扫。150 ms 去抖：重写是成批的，逐节点扫会把主线程
       占满。 */
    var mo = new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i++) {
        if (records[i].addedNodes && records[i].addedNodes.length) {
          schedule();
          return;
        }
      }
    });

    mo.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", start);
  else start();
}

/* 交出一个 baseclass 派生类，而不是裸函数。

   LuCI 的判定是 `Class.isSubclass(v)`，其实现为
   `typeof v === 'function' && v.prototype instanceof Class`。裸函数通不过这一
   条，控制台就会报 `"table-sort" factory yields invalid constructor` 并打断
   同页后续脚本 —— 这就是本文件上一版的真实故障。

   __init__ 里跑副作用，与同目录 sidebar-shadcn.js / router-shadcn.js 的写法
   一致；本文件不需要实例状态，所以类体是空的。 */
return baseclass.extend({
  __init__() {
    startTableSort();
  },
});
