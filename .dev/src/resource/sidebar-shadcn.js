"use strict";
"require baseclass";

// The theme ships one scheme (.dev/docs/adr/0002-dark-only.md). `data-darkmode`
// is written once, pre-paint, by header.ut — that is the only writer. It is not
// deleted here or anywhere else: three third-party packages on the router read
// it (dnschain, trafficctl, bootstrap's cascade.css) to pick their own dark
// token set, so removing the attribute would flip them back to light.
//
// This key is the leftover of the light/dark/device switch that used to exist.
// Nothing reads it any more; deleting it on start stops a stale preference from
// outliving the switch it belonged to.
const THEME_KEY = "shadcn.theme";

/* 「固定展开」标记。旧键 shadcn.sidebar 存的是「是否收起」，语义正好相反；
   默认改成收起之后旧值不再有意义，所以换一个键，不读旧值。

   只记固定展开：悬浮展开是瞬时状态，写进存储会让刷新后的侧边栏状态取决于
   上次指针停在哪里。 */
const SIDEBAR_PINNED_KEY = "shadcn.sidebar.pinned";

return baseclass.extend({
  __init__() {
    const sidebar = document.getElementById("sidebar");
    if (sidebar?.getAttribute("data-shadcn-built") === "1") {
      this._start();
      return;
    }

    document.addEventListener("shadcn-sidebar-ready", () => this._start(), {
      once: true,
    });
  },

  _start() {
    if (this._started) return;
    const sidebar = document.getElementById("sidebar");
    if (sidebar?.getAttribute("data-shadcn-built") !== "1") return;
    this._started = true;

    this.initTheme();
    this.initSidebar();
    this.initMobileDrawer();
  },

  /* ── Theme ── */

  // One scheme only. header.ut sets data-darkmode before paint and is the only
  // writer; this drops the key the removed three-way switch used to write.
  initTheme() {
    try {
      localStorage.removeItem(THEME_KEY);
    } catch (e) {}
  },

  /* ── Sidebar collapse (desktop icon rail) ── */

  initSidebar() {
    const sidebar = document.getElementById("sidebar");
    if (!sidebar) return;

    const bp = getComputedStyle(document.documentElement)
      .getPropertyValue("--breakpoint-md")
      .trim();
    this._mobileQuery = window.matchMedia(`(width < ${bp})`);
    this._mobileQuery.addEventListener("change", (e) => {
      if (!e.matches) this._hideCollapsedPopover();
    });

    /* 桌面侧边栏的三种状态。

       1. 收起（默认）。图标轨，宽 3rem。
       2. 悬浮展开。指针停在侧边栏上时临时铺开，指针离开就收回去 —— 这是
          「默认收起」还够用的关键：偶尔要看一眼菜单不必先点按钮。
       3. 固定展开。点过展开按钮之后一直展开，直到再点一次。

       为什么需要第 3 种：只有悬浮展开时，把指针移到主内容区侧边栏就收了，
       正在读的子菜单会跟着消失。用户点按钮的动作表达的是「我要它一直开着」。

       存储只记第 3 种（pinned）。悬浮是瞬时状态，不该写进 localStorage ——
       否则刷新后侧边栏会因为上次指针恰好停在那里而展开。

       旧键 shadcn.sidebar 存的是布尔「是否收起」。现在默认收起，那个值不再
       需要迁移：读它只会让曾经收起过的用户「恰好」符合新默认。 */
    const pinned = localStorage.getItem(SIDEBAR_PINNED_KEY) === "true";
    this._pinned = pinned;
    this._hovering = false;
    sidebar.setAttribute("data-collapsed", pinned ? "false" : "true");

    const toggleBtn = document.getElementById("sidebar-toggle-btn");
    if (toggleBtn) {
      toggleBtn.addEventListener("click", () => {
        if (this._mobileQuery.matches) {
          this.closeDrawer();
        } else {
          this.toggleCollapse();
        }
      });
    }

    this._initHoverExpand();

    this._initAccordion();
    this._initCollapsedPopover();
  },

  /* 悬浮展开 / 收回。

     只有一个属性分工：

       #sidebar[data-collapsed]        「内容是否铺开」—— 决定标签、箭头、子
                                       列表显不显示，也是 _initAccordion 与
                                       折叠面板判定的依据。

     侧边栏在桌面上是**固定定位**（见 _layout.css），不参与文档流；内容靠
     #main-wrapper 的 padding-left 让开它的宽度，而这个 padding 读的是
     --sidebar-inset，由 data-sidebar-collapsed 驱动。所以悬浮展开和点按钮
     固定展开走的是同一条避让路径：内容让开 16rem，而不是被盖住。

     原来还有一个 html[data-sidebar-floating] 用来把悬浮态切成 absolute，
     免得指针扫过侧边栏时内容跟着缩。侧边栏既然永远脱离文档流，这个属性就
     没有存在意义了，已删除。

     **退场要判断指针去了哪，不能一离开就收。** 子菜单抽屉固定在侧边栏右缘，
     两者不重叠，所以「从侧边栏内的菜单项水平右移到抽屉」必然先经过一个
     pointerleave。原来收到 pointerleave 就立刻收起，结果是抽屉还开着、侧边栏
     却缩回图标轨，随后抽屉失去依托也关掉 —— 二级菜单根本点不到。

     现在的做法：pointerleave 不直接收，而是起一个短宽限计时；指针在宽限内进入
     抽屉就把计时取消。

     只对鼠标生效：触屏没有 hover，pointerenter 会跟着 tap 一起触发，那时
     应该什么都不做（手机上走抽屉）。 */
  _initHoverExpand() {
    const sidebar = document.getElementById("sidebar");
    if (!sidebar) return;

    const mouseOnly = (e) => !e.pointerType || e.pointerType === "mouse";

    /* 记下指针坐标。宽限期到期时要判断「指针是不是已经移到抽屉上」，而那一刻
       不会再有新事件可听 —— 只能看最后一次已知位置。 */
    document.addEventListener("pointermove", (e) => {
      if (!mouseOnly(e)) return;
      this._pointer = { x: e.clientX, y: e.clientY };
    });

    sidebar.addEventListener("pointerenter", (e) => {
      if (this._mobileQuery.matches) return;
      if (!mouseOnly(e)) return;
      if (this._pinned) return;
      this._cancelLeave();
      this._hovering = true;
      this._applyCollapsed(false, { animate: false });
    });

    sidebar.addEventListener("pointerleave", () => {
      if (!this._hovering) return;
      if (this._pinned) return;
      this._scheduleLeave();
    });

    /* 抽屉是「悬浮展开」的下游面板：指针移进去时侧边栏必须保持展开。
       拖动光标时指针不会触发侧边栏的 pointerleave → 抽屉 pointerenter 这条
       链路之外还有别的路径（比如从抽屉回到侧边栏），所以两边都监听。 */
    document.addEventListener("pointerover", (e) => {
      if (!this._hovering) return;
      if (!e.target.closest?.("#sidebar-subdrawer")) return;
      this._cancelLeave();
    });

    /* 指针离开抽屉时要重新起一次宽限判定。

       少了这一条会出现「抽屉永远挂着」：离开侧边栏时因为指针在抽屉里、收起
       被推迟；之后指针从抽屉直接移向内容区，侧边栏早已不再收到 pointerleave
       （指针本来就不在侧边栏里），于是没有任何东西再把收起排上日程。 */
    document.addEventListener("pointerout", (e) => {
      if (!this._hovering) return;
      if (this._pinned) return;
      const from = e.target.closest?.("#sidebar-subdrawer");
      if (!from) return;
      const to = e.relatedTarget;
      if (to && to.closest?.("#sidebar-subdrawer")) return;
      if (to && to.closest?.("#sidebar")) {
        this._cancelLeave();
        return;
      }
      this._scheduleLeave();
    });
  },

  /* 宽限期：给指针从侧边栏走到抽屉的时间。

     120ms 是实测能覆盖「从菜单项右移 30px 进抽屉」的时长；再长会让指针真的
     离开时收起动作显得迟钝。计时器只在这一个场合用，所以挂在实例上而不是
     模块级。

     收起条件里带一个「抽屉是否开着」的判断：只靠计时器的话，指针停在抽屉里
     不动（没有任何新的 pointer 事件）仍会在 120ms 后收起 —— 那正是要避免的。 */
  _scheduleLeave() {
    this._cancelLeave();
    this._leaveTimer = window.setTimeout(() => {
      this._leaveTimer = null;
      if (this._pinned) return;
      if (this._pointerOverPanel()) return;
      this._hovering = false;
      this._applyCollapsed(true, { animate: false });
      this._hideCollapsedPopover();
    }, 120);
  },

  _cancelLeave() {
    if (this._leaveTimer) {
      window.clearTimeout(this._leaveTimer);
      this._leaveTimer = null;
    }
  },

  /* 指针此刻是否停在依附于侧边栏的面板上（子菜单抽屉或收起态浮层）。

     用几何判断而不是 `:hover`：宽限期只有一个帧级别的窗口，而浏览器把指针
     标记为 `:hover` 需要它先派发过对应的 pointerover。实测在「离开侧边栏、
     进入抽屉」这样一次跨越里，120ms 到期时 `#sidebar-subdrawer:hover` 还是
     false（指针坐标已经在抽屉内，但 hover 状态还没落地），于是误判成「指针
     没在面板上」直接收起 —— 就是用户看到的那个 bug。

     矩形判断不依赖事件时序，指针在不在框里一算就知道。

     rect 的判定留 4px 余量：抽屉贴侧边栏右缘，取整误差会让边界那一像素
     落在框外。 */
  _pointerOverPanel() {
    const p = this._pointer;
    if (!p) return false;

    const panels = ["#sidebar-subdrawer", "#sidebar-collapsed-popover"];
    for (const sel of panels) {
      const el = document.querySelector(sel);
      if (!el || el.hidden) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (
        p.x >= r.left - 4 &&
        p.x <= r.right + 4 &&
        p.y >= r.top - 4 &&
        p.y <= r.bottom + 4
      )
        return true;
    }

    return false;
  },

  /* 写折叠状态。`animate` 为 false 时摘掉 data-sidebar-anim，让这次切换不走
     宽度过渡；悬浮展开必须这样，指针划过去时 200ms 的宽度动画既拖沓又让
     浮层跟不上指针。

     data-sidebar-collapsed 同时驱动两件事：侧边栏自己的宽度，以及
     #main-wrapper 的 padding-left（--sidebar-inset）。所以写一次属性，避让
     和宽度一起变，不会出现「内容让开了但侧边栏还没宽」的中间帧。 */
  _applyCollapsed(collapsed, opts) {
    const sidebar = document.getElementById("sidebar");
    if (!sidebar) return;

    const o = opts ?? {};
    const anim = o.animate !== false;
    if (anim) document.documentElement.setAttribute("data-sidebar-anim", "");
    else document.documentElement.removeAttribute("data-sidebar-anim");

    sidebar.setAttribute("data-collapsed", collapsed ? "true" : "false");
    document.documentElement.setAttribute(
      "data-sidebar-collapsed",
      collapsed ? "true" : "false",
    );

    if (collapsed) {
      document
        .querySelectorAll(".sidebar-accordion-item[data-open='true']")
        .forEach((item) => {
          this._closeAccordionItem(item);
        });

      /* 侧边栏收成图标轨后，贴在它右缘的子菜单抽屉就没有依托了 —— 它会留在
         原地、指向一列已经没有文字的图标。收起时一并关掉，两层浮面要么都开、
         要么都关。closeSubDrawer 会同时清掉 html[data-sidebar-sub]，所以
         二级避让也跟着退掉。 */
      window.ShadcnMenu?.closeSubDrawer?.();
    }
  },

  toggleCollapse() {
    const sidebar = document.getElementById("sidebar");
    if (!sidebar) return;

    /* 点按钮 = 切换「固定展开」。当前固定展开就取消固定并收回；否则固定
       展开。悬浮展开中点按钮也走这里 —— 用户意图明确是「钉住」。 */
    const next = !this._pinned;
    this._pinned = next;
    localStorage.setItem(SIDEBAR_PINNED_KEY, next ? "true" : "false");

    this._hovering = false;
    // 固定展开要占位，所以不带 floating。
    this._applyCollapsed(!next, { animate: true });
    this._hideCollapsedPopover();
  },

  /* 点过二级菜单项之后，把整层浮面收回 —— 两级都收，并复位。

     需求是「点完二级项收起所有侧边栏复位」，所以这里**连 pinned 一起清**：
     用户选完了一个目的地，画面上不该再摊着两层菜单，下次回到页面时也该是
     默认的收起态。这与 toggleCollapse 的「记住我的偏好」是两种语义，各自
     独立。

     顺序要紧：先收二级面板（它自己会清 html[data-sidebar-sub]，二级避让随之
     退掉），再收一级侧边栏（--sidebar-inset 回落到 --sidebar-w-rail）。两步
     都摘掉 data-sidebar-anim，因为收起发生在点击之后、页面导航的同一帧里，
     200ms 的过渡会和即将到来的内容替换叠在一起，看起来像卡了一下。 */
  collapseAfterNavigate() {
    this._cancelLeave();
    this._hovering = false;

    window.ShadcnMenu?.closeSubDrawer?.();

    if (this._pinned) {
      this._pinned = false;
      localStorage.setItem(SIDEBAR_PINNED_KEY, "false");
    }

    this._applyCollapsed(true, { animate: false });
    this._hideCollapsedPopover();
  },

  /* ── Collapsed hover popover ── */

  _initCollapsedPopover() {
    document.addEventListener("mouseover", (e) => {
      const sidebar = document.getElementById("sidebar");
      if (sidebar?.getAttribute("data-collapsed") !== "true") return;

      if (e.target.closest("#sidebar-collapsed-popover")) {
        clearTimeout(this._popoverTimer);
        return;
      }

      const item = e.target.closest(".sidebar-accordion-item");
      if (item) {
        clearTimeout(this._popoverTimer);
        this._showCollapsedPopover(item);
      }
    });

    document.addEventListener("mouseout", (e) => {
      const sidebar = document.getElementById("sidebar");
      if (sidebar?.getAttribute("data-collapsed") !== "true") return;

      const isFromRelevant =
        e.target.closest(".sidebar-accordion-item") ||
        e.target.closest("#sidebar-collapsed-popover");
      if (!isFromRelevant) return;

      const to = e.relatedTarget;
      const isToRelevant =
        to &&
        (to.closest(".sidebar-accordion-item") ||
          to.closest("#sidebar-collapsed-popover"));

      if (!isToRelevant) {
        this._popoverTimer = setTimeout(
          () => this._hideCollapsedPopover(),
          100,
        );
      }
    });
  },

  _showCollapsedPopover(item) {
    const section = item.getAttribute("data-section") || "";
    const existing = document.getElementById("sidebar-collapsed-popover");
    if (existing && existing.getAttribute("data-section") === section) return;

    this._hideCollapsedPopover();

    const links = item.querySelectorAll(".sidebar-sub-link");
    if (!links.length) return;

    const label = item.querySelector(".sidebar-label");
    const title = label ? label.textContent.trim() : "";

    const popover = document.createElement("div");
    popover.id = "sidebar-collapsed-popover";
    popover.className = "sidebar-collapsed-popover";
    popover.setAttribute("data-section", section);

    if (title) {
      const h = document.createElement("div");
      h.className = "sidebar-collapsed-popover-title";
      h.textContent = title;
      popover.appendChild(h);
    }

    const ul = document.createElement("ul");
    ul.className = "sidebar-collapsed-popover-list";

    links.forEach((link) => {
      const isActive = link
        .closest(".sidebar-sub-item")
        ?.classList.contains("active");
      const li = document.createElement("li");
      const a = document.createElement("a");
      a.href = link.href;
      a.className =
        "sidebar-collapsed-popover-link" + (isActive ? " active" : "");
      a.textContent = link.textContent;
      li.appendChild(a);
      ul.appendChild(li);
    });

    popover.appendChild(ul);
    document.body.appendChild(popover);

    const sidebar = document.getElementById("sidebar");
    const sidebarRect = sidebar.getBoundingClientRect();
    const itemRect = item.getBoundingClientRect();

    popover.style.left = sidebarRect.right + 4 + "px";

    const top = Math.min(
      itemRect.top,
      window.innerHeight - popover.offsetHeight - 8,
    );
    popover.style.top = Math.max(8, top) + "px";
  },

  _hideCollapsedPopover() {
    clearTimeout(this._popoverTimer);
    const el = document.getElementById("sidebar-collapsed-popover");
    if (el) el.remove();
  },

  /* ── Accordion ── */

  /* 一级项点击 → 打开全高抽屉，不再就地展开。

     原来点一级项会把子列表在手风琴里展开（grid 0fr↔1fr）。改成抽屉之后，
     手风琴的展开动画只是「点开又收起」的中间态，反而让侧边栏跳一下；而且
     同一份子项在两处同时出现也没有意义。所以这里只负责把点击转成抽屉，
     侧边栏本身保持收起 —— 一级菜单始终是一列固定高度的行。

     侧边栏折叠成图标轨（data-collapsed）时行为不变：那时本来就靠悬浮面板
     （sidebar-shadcn 的 collapsed popover）显示子项，不该再开第二个浮层。 */
  _initAccordion() {
    document.addEventListener("click", (e) => {
      const trigger = e.target.closest(".sidebar-nav-parent");
      if (!trigger) return;

      const sidebar = document.getElementById("sidebar");
      if (sidebar?.getAttribute("data-collapsed") === "true") return;

      const item = trigger.closest(".sidebar-accordion-item");
      if (!item) return;

      // 抽屉由 menu-shadcn 负责渲染（它握有 ui.menu 的数据）。
      if (window.ShadcnMenu?.openSubDrawer) {
        window.ShadcnMenu.openSubDrawer(item);
        return;
      }

      /* 兜底：menu-shadcn 还没加载完时退回手风琴，不让点击变成没反应。
         正常情况下走不到这里 —— 菜单是先渲染出来才可能被点的。 */
      const isOpen = item.getAttribute("data-open") === "true";

      document
        .querySelectorAll(".sidebar-accordion-item[data-open='true']")
        .forEach((other) => {
          if (other !== item) this._closeAccordionItem(other);
        });

      if (isOpen) {
        this._closeAccordionItem(item);
      } else {
        this._openAccordionItem(item);
      }
    });

    /* 兜底不在 JS 里做，交给 CSS：_layout.css 把 .sidebar-accordion-sub
       强制为收起，因此无论谁把 data-open 写成 true，侧边栏都不会展开。
       这样不必为「纠正属性」额外背一个 MutationObserver 的体积。 */
  },

  _openAccordionItem(item) {
    item.setAttribute("data-open", "true");
  },

  _closeAccordionItem(item) {
    item.setAttribute("data-open", "false");
  },

  /* ── Mobile drawer ── */

  initMobileDrawer() {
    const hamburger = document.getElementById("sidebar-hamburger");
    const overlay = document.getElementById("sidebar-overlay");

    if (hamburger) {
      hamburger.addEventListener("click", () => this.openDrawer());
    }
    if (overlay) {
      overlay.addEventListener("click", () => this.closeDrawer());
    }

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this.closeDrawer();
    });
  },

  openDrawer() {
    const sidebar = document.getElementById("sidebar");
    const overlay = document.getElementById("sidebar-overlay");
    if (!sidebar) return;
    sidebar.setAttribute("data-drawer-open", "true");
    overlay?.classList.add("active");
    document.body.style.overflow = "hidden";
  },

  closeDrawer() {
    const sidebar = document.getElementById("sidebar");
    const overlay = document.getElementById("sidebar-overlay");
    if (!sidebar) return;
    sidebar.setAttribute("data-drawer-open", "false");
    overlay?.classList.remove("active");
    document.body.style.overflow = "";
  },
});
