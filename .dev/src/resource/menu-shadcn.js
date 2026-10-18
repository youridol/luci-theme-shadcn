"use strict";
"require baseclass";
"require ui";

/**
 * Shadcn sidebar + menu: empty #sidebar in header.ut, chrome built here.
 * Menu depth: top + one submenu level in the sidebar; deeper levels render
 * as #tabmenu tabs.
 */

/** LuCI menu node `name` → icon basename under /luci-static/shadcn/icons/.
    First-level nodes only — sub-level names such as firewall
    (admin/network/firewall) or opkg (admin/system/opkg) never hit this map
    and were removed as dead entries. */
const ICON_MAP = {
  status: "activity",
  system: "settings",
  network: "network",
  services: "layers",
  nas: "hard-drive",
  control: "sliders-horizontal",
  vpn: "shield",
  docker: "container",
  statistics: "chart-bar",
  nlbw: "gauge",
  /** Covers VoIP/PBX apps — no official OpenWrt package registers a
      verified menu.d node under this name, best-effort key */
  asterisk: "phone",
  /** luci-base `admin/logout` leaf */
  logout: "log-out",
  default: "layout-dashboard",
};

/** sessionStorage key replayed pre-paint by the inline script in header.ut */
const CACHE_KEY = "shadcn.sidebar.cache";

/** localStorage key for the palette's most-recently-used page paths */
const RECENTS_KEY = "shadcn.palette.recents";

return baseclass.extend({
  __init__() {
    ui.menu.load().then((tree) => {
      this.renderSidebarChrome();
      this.render(tree);
      this.initUciIndicator();
      this.cacheSidebar();
      window.addEventListener("pagehide", () => this.cacheSidebar());
      document.dispatchEvent(new Event("shadcn-sidebar-ready"));
    });
  },

  /**
   * Snapshot the rendered sidebar so header.ut can replay it in the first
   * frame of the next navigation (pagehide keeps accordion/scroll current).
   */
  cacheSidebar() {
    // Set by header.ut's delegated logout-click listener.
    if (window.shadcnSuppressSidebarCache) return;
    const sidebar = document.getElementById("sidebar");
    const nav = document.getElementById("sidebar-nav");
    if (!sidebar || !nav) return;
    try {
      sessionStorage.setItem(
        CACHE_KEY,
        JSON.stringify({
          v: 1,
          lang: document.documentElement.lang || "",
          html: sidebar.innerHTML,
          scroll: nav.scrollTop || 0,
        }),
      );
    } catch (e) {
      /* storage full/disabled — next page just builds normally */
    }
  },

  _mediaBase() {
    const fromHtml = document.documentElement.getAttribute("data-shadcn-media");
    const side = document.getElementById("sidebar");
    const fromSide = side && side.getAttribute("data-media");
    const raw = fromHtml || fromSide || "/luci-static/shadcn";
    return String(raw).replace(/\/$/, "");
  },

  _sectionIcon(sectionName, size) {
    const key = String(sectionName || "").toLowerCase();
    const icon = ICON_MAP[key] || ICON_MAP.default;
    return this._iconFile(icon, size);
  },

  /** luci-base menu `admin/logout` — render in sidebar footer, not main nav */
  _isLogoutMenuItem(section) {
    const n = String(
      section && section.name != null ? section.name : "",
    ).toLowerCase();
    return n === "logout" || n.endsWith("/logout");
  },

  /**
   * An icon box, not an <img>: the theme paints icons with `mask` + `bg-current`
   * (.dev/docs/adr/0006-mask-icon-boxes.md), so the shape follows whatever
   * `color` the surrounding row has. The URL stays outside the bundle because
   * these names are chosen at runtime from ICON_MAP.
   */
  _iconFile(name, size) {
    const media = this._mediaBase();
    const box = E("span", {
      class: "shadcn-icon",
      "aria-hidden": "true",
      style: `--shadcn-icon:url(${media}/icons/${name}.svg);--shadcn-icon-size:${size}px`,
    });
    return box;
  },

  /**
   * LuCI root often has one child (admin / 管理权). Sidebar lists that child’s
   * children rather than the single root node itself.
   */
  _resolveMenuBranch(tree) {
    const dp = L.env.dispatchpath || [];
    const rp = L.env.requestpath || [];
    const top = ui.menu.getChildren(tree);
    let branchName = (rp.length && rp[0]) || (dp.length && dp[0]) || "admin";
    let branch = null;

    for (let i = 0; i < top.length; i++) {
      if (top[i].name === branchName) {
        branch = top[i];
        break;
      }
    }

    if (!branch && top.length === 1) {
      branch = top[0];
      branchName = branch.name;
    }

    if (!branch) branch = tree;

    return { branch, branchUrl: branch.name || branchName };
  },

  /**
   * Populates the empty server-rendered #sidebar shell with its chrome.
   */
  renderSidebarChrome() {
    const sidebar = document.getElementById("sidebar");
    if (!sidebar) return;
    if (sidebar.getAttribute("data-shadcn-built") === "1") {
      // Restored from cache — chrome exists; just sync a possibly stale hostname.
      const brand = sidebar.querySelector(".sidebar-brand-text");
      const host = sidebar.getAttribute("data-hostname");
      if (brand && host && brand.textContent !== host) brand.textContent = host;
      return;
    }
    sidebar.setAttribute("data-shadcn-built", "1");

    const media = this._mediaBase();
    const host = sidebar.getAttribute("data-hostname") || "Shadcn";

    while (sidebar.firstChild) sidebar.removeChild(sidebar.firstChild);

    sidebar.appendChild(
      E("div", { class: "sidebar-header" }, [
        E("a", { class: "sidebar-brand", href: "/" }, [
          E("img", {
            class: "sidebar-logo",
            src: `${media}/images/logo.svg`,
            alt: "Shadcn",
            width: "24",
            height: "24",
          }),
          E("span", { class: "sidebar-brand-text" }, [host]),
        ]),
        E(
          "button",
          {
            id: "sidebar-toggle-btn",
            class: "sidebar-toggle",
            type: "button",
            "aria-label": _("Navigation"),
          },
          [
            E("span", { class: "icon-collapse" }, [
              this._iconFile("panel-left-close", 16),
            ]),
            E("span", { class: "icon-expand" }, [
              this._iconFile("panel-left-open", 16),
            ]),
          ],
        ),
      ]),
    );

    sidebar.appendChild(E("nav", { class: "sidebar-nav", id: "sidebar-nav" }));

    sidebar.appendChild(
      E("div", { class: "sidebar-footer", id: "sidebar-footer", hidden: "" }),
    );
  },

  render(tree) {
    const { branch, branchUrl } = this._resolveMenuBranch(tree);
    this.tree = tree;
    this.branch = branch;
    this.branchUrl = branchUrl;

    this.renderSidebarNav(branch, branchUrl);
    this.renderBreadcrumb(branch, branchUrl);
    this.initPalette(branch, branchUrl);
    this.renderTabs(tree);
  },

  renderTabs(tree) {
    const dp = L.env.dispatchpath || [];
    const tab = document.getElementById("tabmenu");
    if (tab) {
      tab.innerHTML = "";
      tab.style.display = "none";
    }

    let node = tree;
    let url = "";
    if (dp.length >= 3) {
      for (var i = 0; i < 3 && node; i++) {
        const key = dp[i];
        if (!node.children || !node.children[key]) break;
        node = node.children[key];
        url = url + (url ? "/" : "") + key;
      }
      if (node) this.renderTabMenu(node, url);
    }
  },

  // Re-marks the sidebar, crumb and tabs from L.env after a same-document
  // navigation (router-shadcn.js). The sidebar keeps its DOM; only the
  // active highlight moves — the same longest-link-prefix rule header.ut's
  // pre-paint replay applies to the cached markup.
  syncRoute() {
    if (!this.tree) return;

    const sidebar = document.getElementById("sidebar");
    if (sidebar) {
      sidebar
        .querySelectorAll(".active")
        .forEach((el) => el.classList.remove("active"));

      const path = new URL(
        L.url(...(L.env.dispatchpath || []).slice(0, 3)),
        location.href,
      ).pathname;
      let best = null;
      let bestLen = -1;
      sidebar
        .querySelectorAll(
          "a.sidebar-sub-link, a.sidebar-nav-parent, a.sidebar-logout",
        )
        .forEach((a) => {
          const p = a.pathname;
          if ((path === p || path.startsWith(p + "/")) && p.length > bestLen) {
            best = a;
            bestLen = p.length;
          }
        });

      if (best) {
        const sub = best.closest(".sidebar-sub-item");
        if (sub) {
          sub.classList.add("active");
          const acc = best.closest(".sidebar-accordion-item");
          if (acc) {
            acc.classList.add("active");
            if (sidebar.getAttribute("data-collapsed") !== "true") {
              sidebar
                .querySelectorAll(".sidebar-accordion-item")
                .forEach((item) =>
                  item.setAttribute(
                    "data-open",
                    item === acc ? "true" : "false",
                  ),
                );
            }
          }
        } else if (best.classList.contains("sidebar-logout")) {
          best.classList.add("active");
        } else {
          best.closest(".sidebar-nav-item")?.classList.add("active");
        }
      }
    }

    this.renderBreadcrumb(this.branch, this.branchUrl);
    this.renderTabs(this.tree);
  },

  closeSurfaces() {
    this.closePalette();
    window.ShadcnSidebar?.closeDrawer?.();
    window.ShadcnSidebar?._hideCollapsedPopover?.();
  },

  /**
   * Two levels under the active branch (e.g. admin): 状态 → 概览…
   * Capped at l <= 2; anything deeper renders in #tabmenu.
   */
  renderSidebarNav(branch, branchUrl) {
    const nav = document.getElementById("sidebar-nav");
    const foot = document.getElementById("sidebar-footer");
    if (!nav) return;

    const children = ui.menu.getChildren(branch);
    const dp = L.env.dispatchpath || [];

    // If header.ut replayed the cached sidebar, this rebuild is a silent
    // refresh — keep the user's accordion/scroll state instead of resetting
    // to the default (active section open, scrolled to top).
    const restored =
      document
        .getElementById("sidebar")
        ?.getAttribute("data-shadcn-restored") === "1";
    const openSections = restored
      ? Array.from(
          nav.querySelectorAll('.sidebar-accordion-item[data-open="true"]'),
          (el) => el.getAttribute("data-section"),
        )
      : null;
    const savedScrollTop = restored ? nav.scrollTop : 0;

    nav.innerHTML = "";
    if (foot) {
      foot.innerHTML = "";
      foot.hidden = true;
    }

    children.forEach((section) => {
      if (this._isLogoutMenuItem(section) && foot) {
        const isActive = dp[1] == section.name;
        const iconEl = this._sectionIcon(section.name, 16);
        foot.appendChild(
          E(
            "a",
            {
              class: "sidebar-logout" + (isActive ? " active" : ""),
              href: L.url(branchUrl, section.name),
              "aria-label": _(section.title),
              onclick: () => {
                if (window.ShadcnSidebar && window.ShadcnSidebar.closeDrawer) {
                  window.ShadcnSidebar.closeDrawer();
                }
              },
            },
            [
              E("span", { class: "sidebar-icon", "aria-hidden": "true" }, [
                iconEl,
              ]),
              E("span", { class: "sidebar-label" }, [_(section.title)]),
            ],
          ),
        );
        foot.hidden = false;
        return;
      }

      const subs = ui.menu.getChildren(section);
      const isActive = dp[1] == section.name;
      const iconEl = this._sectionIcon(section.name, 16);

      if (subs.length === 0) {
        nav.appendChild(
          E(
            "div",
            { class: "sidebar-nav-item" + (isActive ? " active" : "") },
            [
              E(
                "a",
                {
                  class: "sidebar-nav-parent no-sub",
                  href: L.url(branchUrl, section.name),
                  onclick: () => {
                    if (
                      window.ShadcnSidebar &&
                      window.ShadcnSidebar.closeDrawer
                    ) {
                      window.ShadcnSidebar.closeDrawer();
                    }
                  },
                },
                [
                  E("span", { class: "sidebar-icon", "aria-hidden": "true" }, [
                    iconEl,
                  ]),
                  E("span", { class: "sidebar-label" }, [_(section.title)]),
                ],
              ),
            ],
          ),
        );
        return;
      }

      const item = E(
        "div",
        {
          class: "sidebar-accordion-item" + (isActive ? " active" : ""),
          "data-open": isActive ? "true" : "false",
          "data-section": section.name,
        },
        [
          E("button", { class: "sidebar-nav-parent", type: "button" }, [
            E("span", { class: "sidebar-icon", "aria-hidden": "true" }, [
              iconEl,
            ]),
            E("span", { class: "sidebar-label" }, [_(section.title)]),
            E("span", { class: "sidebar-chevron", "aria-hidden": "true" }, [
              this._iconFile("chevron-down", 18),
            ]),
          ]),
          E("div", { class: "sidebar-accordion-sub" }, [
            E(
              "ul",
              { class: "sidebar-sub-list" },
              subs.map((page) => {
                const isPageActive = isActive && dp[2] == page.name;
                return E(
                  "li",
                  {
                    class: "sidebar-sub-item" + (isPageActive ? " active" : ""),
                  },
                  [
                    E(
                      "a",
                      {
                        class: "sidebar-sub-link",
                        href: L.url(branchUrl, section.name, page.name),
                        onclick: () => {
                          if (
                            window.ShadcnSidebar &&
                            window.ShadcnSidebar.closeDrawer
                          ) {
                            window.ShadcnSidebar.closeDrawer();
                          }
                        },
                      },
                      [_(page.title)],
                    ),
                  ],
                );
              }),
            ),
          ]),
        ],
      );

      nav.appendChild(item);
    });

    if (restored) {
      nav.querySelectorAll(".sidebar-accordion-item").forEach((item) => {
        item.setAttribute(
          "data-open",
          openSections.includes(item.getAttribute("data-section"))
            ? "true"
            : "false",
        );
      });
      nav.scrollTop = savedScrollTop;
    }

    /* 给每个带子菜单的一级项挂上抽屉入口。
       用 data 标记防重复绑定：renderSidebarNav 会在每次路由同步后重跑，而
       nav.innerHTML = "" 已经清掉了旧节点，新节点天然没有标记，所以标记只是
       为了防止同一次渲染里被绑两遍。 */
    this._subDrawer();
    for (const item of nav.querySelectorAll(".sidebar-accordion-item")) {
      const parent = item.querySelector(".sidebar-nav-parent");
      if (!parent || parent.dataset.subdrawer) continue;

      parent.dataset.subdrawer = "1";
      // 悬停与聚焦都开：Tab 到一级项时也能看到子项，不只鼠标。
      parent.addEventListener("mouseenter", () => this.openSubDrawer(item));
      parent.addEventListener("focus", () => this.openSubDrawer(item));
    }
  },

  /* ── 子菜单抽屉 ─────────────────────────────────────────────────────────

     侧边栏一级菜单悬停/聚焦时，在它的右缘滑出该分区的子项。

     与手风琴并存而不是替代它：手风琴是「就地展开」，抽屉是「展开成一层独立
     面板」，两者共用 ui.menu 这同一份数据。DOM 不复用 —— 手风琴的列表靠 CSS
     grid 0fr↔1fr 过渡，把节点挪到 body 会让过渡在移动瞬间失参。

     定位由 JS 写 left/top/max-height：要读侧边栏的实时宽度（折叠成图标轨时
  /* ── 子菜单抽屉 ─────────────────────────────────────────────────────────

     侧边栏一级菜单悬停/聚焦时，在它的右缘滑出该分区的子项。

     与手风琴并存：手风琴是「就地展开」，抽屉是「展开成一层独立面板」，两者
     共用 ui.menu 这一份数据。DOM 不复用 —— 手风琴靠 CSS grid 0fr↔1fr 过渡，
     把节点挪到 body 会让过渡在移动瞬间失参。

     位置由 CSS 算：抽屉挂在 #sidebar 里，`position: fixed` + `left` 由 JS 填
     一次侧边栏宽度。折叠成图标轨时侧边栏宽度变化，靠 #sidebar 上的
     data-collapsed 属性触发 CSS 重算，不需要 resize 监听。 */
  _subDrawer() {
    let panel = document.getElementById("sidebar-subdrawer");
    if (panel) return panel;

    panel = document.createElement("div");
    panel.id = "sidebar-subdrawer";
    panel.className = "sidebar-subdrawer";
    panel.setAttribute("role", "menu");
    panel.hidden = true;
    document.body.appendChild(panel);

    // 捕获阶段：链路点击会先冒泡到自己的 handler，晚一步就收不到外面的点击。
    document.addEventListener(
      "pointerdown",
      (e) => {
        if (panel.hidden) return;
        if (panel.contains(e.target)) return;
        if (e.target.closest?.(".sidebar-accordion-item")) return;
        this.closeSubDrawer();
      },
      true,
    );
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this.closeSubDrawer();
    });

    return panel;
  },

  openSubDrawer(item) {
    const panel = this._subDrawer();
    const name = item.getAttribute("data-section");
    const list = item.querySelector(".sidebar-sub-list");
    if (!list) return;

    // 同一分区已开：只挪位置，不重建 DOM。
    if (panel.dataset.section !== name || panel.hidden) {
      panel.dataset.section = name;
      panel.innerHTML = "";

      const head = document.createElement("div");
      head.className = "sidebar-subdrawer-head";
      head.textContent =
        item.querySelector(".sidebar-label")?.textContent ?? "";
      panel.appendChild(head);

      for (const a of list.querySelectorAll("a.sidebar-sub-link")) {
        const link = document.createElement("a");
        link.className =
          "sidebar-subdrawer-link" +
          (a.closest(".sidebar-sub-item")?.classList.contains("active")
            ? " active"
            : "");
        link.href = a.getAttribute("href");
        link.textContent = a.textContent;
        link.setAttribute("role", "menuitem");
        link.addEventListener("click", () => this.closeSubDrawer());
        panel.appendChild(link);
      }

      panel.hidden = false;
      requestAnimationFrame(() => panel.classList.add("is-open"));
    }

    const r = document.getElementById("sidebar").getBoundingClientRect();
    panel.style.left = Math.max(0, Math.round(r.right)) + "px";
    panel.style.top = Math.round(r.top) + 56 + "px";
    panel.style.maxHeight =
      Math.min(window.innerHeight - r.top - 68, r.height) + "px";
  },

  closeSubDrawer() {
    const panel = document.getElementById("sidebar-subdrawer");
    if (!panel || panel.hidden) return;
    panel.classList.remove("is-open");
    // 等过渡跑完再 hidden，否则是直接消失而不是滑出。
    window.setTimeout(() => {
      if (!panel.classList.contains("is-open")) panel.hidden = true;
    }, 160);
  },

  /**
   * Command palette (⌘K), replaces the C1 topbar route search. One panel
   * serves navigation (the same two-level model the sidebar renders) and
   * the ">" command scope — theme modes plus logout; the modes are the
   * only UI able to return to 'device' once the header toggle has written
   * an explicit mode.
   * DOM is built lazily on first open; page load binds one trigger click
   * and one keydown listener.
   * Translation caveat: the dispatcher load_catalog()s the whole
   * /usr/lib/lua/luci/i18n dir into one flat table, so a msgid resolves
   * only if some *installed* package defines it. The theme ships no
   * catalog, so every string here is an existing msgid: luci-base ones
   * are guaranteed, and 'Type to filter…' comes from
   * luci-app-package-manager, a dependency of the default luci
   * collection. Light/Dark are the sole holdouts — no LuCI pot defines
   * them, so they stay English until someone gives the theme a po.
   */
  initPalette(branch, branchUrl) {
    const trigger = document.getElementById("cmdk-trigger");
    if (!trigger || this.palIndex) return;

    this.palIndex = [];
    this.palAliases = {};
    ui.menu.getChildren(branch).forEach((section) => {
      const subs = ui.menu.getChildren(section);
      if (subs.length === 0) {
        this.palIndex.push({
          title: _(section.title),
          group: null,
          icon: section.name,
          path: `${branchUrl}/${section.name}`,
          href: L.url(branchUrl, section.name),
          isLogout: this._isLogoutMenuItem(section),
        });
        return;
      }
      subs.forEach((page) => {
        const title = _(page.title);
        const group = _(section.title);
        const path = `${branchUrl}/${section.name}/${page.name}`;
        // The raw node: getChildren() hands out alias nodes carrying their
        // target's children, which would hide an alias parent's tabs.
        const node = section.children?.[page.name] ?? {};
        const tabs = ui.menu.getChildren(node);
        const type = node.action?.type;
        const target =
          type === "alias"
            ? node.action.path.replace(`${path}/`, "")
            : type === "firstchild" &&
              tabs.find((tab) => !tab.firstchild_ineligible)?.name;

        // A parent that only redirects to one of its tabs is that tab: its
        // row gives way to the tabs, and its path (stored by older recents)
        // resolves to where it redirects.
        if (tabs.some((tab) => tab.name === target))
          this.palAliases[path] = `${path}/${target}`;
        else
          this.palIndex.push({
            title,
            group,
            icon: section.name,
            path,
            href: L.url(branchUrl, section.name, page.name),
            isLogout: false,
          });

        tabs.forEach((tab) =>
          this.palIndex.push({
            title: _(tab.title),
            parent: title,
            group,
            icon: section.name,
            path: `${path}/${tab.name}`,
            href: L.url(branchUrl, section.name, page.name, tab.name),
            isLogout: false,
          }),
        );
      });
    });

    const isMac = /Mac|iP(ad|hone|od)/.test(navigator.platform);
    trigger.setAttribute("aria-keyshortcuts", isMac ? "Meta+K" : "Control+K");
    trigger.addEventListener("click", () => this.openPalette());

    document.addEventListener("keydown", (e) => {
      // An IME swallows these keys while composing; keyCode 229 covers
      // engines that don't set isComposing on the trailing keydown.
      if (e.isComposing || e.keyCode === 229) return;
      // Only the advertised shortcut — ⌘K on Mac, Ctrl+K elsewhere — so
      // macOS Ctrl+K (kill-to-end-of-line in text fields) keeps working.
      if (
        (isMac ? e.metaKey : e.ctrlKey) &&
        !e.altKey &&
        !e.shiftKey &&
        (e.key || "").toLowerCase() === "k"
      ) {
        e.preventDefault();
        if (this.palOverlay && !this.palOverlay.hidden) this.closePalette();
        else this.openPalette();
      } else if (
        e.key === "Escape" &&
        this.palOverlay &&
        !this.palOverlay.hidden
      ) {
        this.closePalette();
      }
    });
  },

  openPalette() {
    if (!this.palOverlay) this._buildPalette();
    // Remember what had focus so closing returns the caret where the user
    // left it — ⌘K can fire from anywhere, not just the trigger.
    const from = document.activeElement;
    this.palReturn =
      from && from !== document.body && !this.palOverlay.contains(from)
        ? from
        : null;
    this.palOverlay.hidden = false;
    this._renderPalette();
    this.palInput.focus();
    this.palInput.select();
  },

  closePalette() {
    if (!this.palOverlay || this.palOverlay.hidden) return;
    this.palOverlay.hidden = true;
    this.palInput.value = "";
    // Hand focus back so a ⌘K → esc round-trip doesn't strand the caret.
    const back = this.palReturn || document.getElementById("cmdk-trigger");
    this.palReturn = null;
    if (back && back.isConnected) back.focus();
  },

  _buildPalette() {
    this.palInput = E("input", {
      class: "cmdk-input",
      type: "text",
      placeholder: _("Type to filter…"),
      // A placeholder is not an accessible name — it is dropped once the
      // field has text. Same msgid as the placeholder, so no new string.
      "aria-label": _("Type to filter…"),
      // Combobox pattern: focus stays in this field the whole time, so the
      // row that ↑/↓ and Enter act on is named by aria-activedescendant
      // rather than by moving focus onto it.
      role: "combobox",
      "aria-expanded": "true",
      "aria-controls": "cmdk-list",
      "aria-autocomplete": "list",
      autocomplete: "off",
      spellcheck: "false",
      enterkeyhint: "go",
    });
    this.palInput.addEventListener("input", () => this._renderPalette());
    this.palInput.addEventListener("keydown", (e) => {
      // Mid-composition these keys belong to the IME: Enter commits the
      // buffer and arrows move inside the candidate list.
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        this._palMove(e.key === "ArrowDown" ? 1 : -1);
      } else if (e.key === "Enter") {
        e.preventDefault();
        this.palList.querySelector(".is-selected")?.click();
      }
    });

    const clear = E("button", {
      class: "cmdk-clear",
      type: "button",
      "aria-label": _("Clear"),
    });
    clear.addEventListener("click", () => {
      this.palInput.value = "";
      this._renderPalette();
      this.palInput.focus();
    });

    const cancel = E("button", { class: "cmdk-cancel", type: "button" }, [
      _("Cancel"),
    ]);
    cancel.addEventListener("click", () => this.closePalette());

    this.palList = E("div", {
      id: "cmdk-list",
      class: "cmdk-list",
      role: "listbox",
      "aria-label": _("Navigation"),
    });
    // mousemove, not mouseover: scrollIntoView() slides rows under a
    // stationary pointer, which fires mouseover and would snap the
    // selection back to whatever the mouse happens to rest on.
    this.palList.addEventListener("mousemove", (e) => {
      const row = e.target?.closest?.(".cmdk-row");
      if (row && !row.classList.contains("is-selected")) this._palSelect(row);
    });

    // All four labels are luci-base msgids, so they are always localized.
    const footer = E("div", { class: "cmdk-footer" }, [
      E("span", { class: "cmdk-hint" }, [
        E("kbd", {}, ["↑"]),
        E("kbd", {}, ["↓"]),
        _("Select"),
      ]),
      E("span", { class: "cmdk-hint" }, [E("kbd", {}, ["↵"]), _("OK")]),
      E("span", { class: "cmdk-hint" }, [E("kbd", {}, [">"]), _("Command")]),
      E("span", { class: "cmdk-hint cmdk-hint-close" }, [
        E("kbd", {}, ["esc"]),
        _("Close"),
      ]),
    ]);

    const panel = E(
      "div",
      {
        class: "cmdk-panel",
        role: "dialog",
        "aria-modal": "true",
        "aria-label": _("Navigation"),
      },
      [
        E("div", { class: "cmdk-inputrow" }, [this.palInput, clear, cancel]),
        this.palList,
        footer,
      ],
    );

    // aria-modal states the intent but does not stop Tab from walking into
    // the obscured page. Rows sit outside the tab order (tabindex -1), so
    // the cycle is just the input row's controls — Clear stays away while
    // the field is empty and Cancel is <md-only, hence offsetParent.
    panel.addEventListener("keydown", (e) => {
      if (e.key !== "Tab") return;
      const ring = [this.palInput, clear, cancel].filter(
        (el) => el.offsetParent !== null,
      );
      if (!ring.length) return;
      e.preventDefault();
      const at = ring.indexOf(document.activeElement);
      ring[(at + (e.shiftKey ? -1 : 1) + ring.length) % ring.length].focus();
    });

    this.palOverlay = E("div", { id: "cmdk-overlay", hidden: "" }, [panel]);
    this.palOverlay.addEventListener("pointerdown", (e) => {
      if (e.target === this.palOverlay) this.closePalette();
    });
    document.body.appendChild(this.palOverlay);
  },

  /**
   * localStorage can be unavailable (privacy modes) or hold anything after
   * a downgrade — both read as "no history". No size cap: dedupe bounds the
   * list by the pages actually visited, i.e. the menu's own scale.
   */
  _palReadRecents() {
    try {
      const list = JSON.parse(localStorage.getItem(RECENTS_KEY));
      if (!Array.isArray(list)) return [];
      return [
        ...new Set(
          list
            .filter((path) => typeof path === "string")
            .map((path) => this.palAliases?.[path] ?? path),
        ),
      ];
    } catch (e) {
      return [];
    }
  },

  _palRecordRecent(path) {
    try {
      localStorage.setItem(
        RECENTS_KEY,
        JSON.stringify([
          path,
          ...this._palReadRecents().filter((kept) => kept !== path),
        ]),
      );
    } catch (e) {
      // History is decorative; a sealed or full store just means none.
    }
  },

  /**
   * Pure LRU browse order: every visited page floats above the untouched
   * ones, so long use converges on a fully most-recently-used list while
   * unvisited pages keep menu order below (the sort is spec-stable). Paths
   * that vanished from the menu drop out. Logout is a command, not a
   * destination: it stays out of the browse list entirely and rides ">"
   * instead (see _renderPalette) — but a typed query still reaches it.
   */
  _palBrowsePages() {
    const recents = this._palReadRecents().filter((path) =>
      this.palIndex.some((page) => page.path === path && !page.isLogout),
    );
    const rank = (page) => {
      const at = recents.indexOf(page.path);
      return at < 0 ? 0 : recents.length - at;
    };
    return this.palIndex
      .filter((page) => !page.isLogout)
      .sort((a, b) => rank(b) - rank(a));
  },

  _renderPalette() {
    const trimmed = this.palInput.value.trimStart();
    const cmdOnly = trimmed.startsWith(">");
    const q = (cmdOnly ? trimmed.slice(1) : trimmed).trim().toLowerCase();

    let rows;
    if (q) {
      const hits = [];
      // ">" scopes to command rows — logout is the only one the theme owns.
      const pool = cmdOnly
        ? this.palIndex.filter((page) => page.isLogout)
        : this.palIndex;
      pool.forEach((page) => {
        const m = this._palScore(
          q,
          page.title,
          page.path,
          page.group,
          page.parent,
        );
        if (m)
          hits.push({
            score: m.score,
            node: this._palPageRow(
              page,
              m.ranges,
              m.groupRanges,
              m.parentRanges,
            ),
          });
      });
      hits.sort((a, b) => b.score - a.score);
      rows = hits.map((h) => h.node);
    } else {
      rows = [];
      if (!cmdOnly) {
        // Navigation only: the theme has one colour scheme, so the palette
        // carries no mode commands and needs no "Design" group heading
        // (.dev/docs/adr/0002-dark-only.md).
        this._palBrowsePages().forEach((page) =>
          rows.push(this._palPageRow(page, null)),
        );
      }
      // Logout rides ">" only — a command, not a destination (mirrors
      // luci-theme-aurora's palette).
      if (cmdOnly) {
        const logout = this.palIndex.find((page) => page.isLogout);
        if (logout) rows.push(this._palPageRow(logout, null));
      }
    }

    if (!rows.length)
      rows = [
        E("div", { class: "cmdk-empty", role: "presentation" }, [
          _("No entries available"),
        ]),
      ];

    this.palList.replaceChildren(...rows);
    this.palList.scrollTop = 0;
    // aria-activedescendant points at an id, and the list is rebuilt on
    // every keystroke, so hand out ids fresh alongside the rows.
    const built = this.palList.querySelectorAll(".cmdk-row");
    built.forEach((row, i) => (row.id = `cmdk-row-${i}`));
    if (built.length) this._palSelect(built[0]);
    else this.palInput.removeAttribute("aria-activedescendant");
  },

  _palPageRow(page, ranges, groupRanges, parentRanges) {
    // Title leads, the section label is demoted to small type on the right
    // edge — same row anatomy as luci-theme-aurora's palette, so the two
    // themes stay legible side by side. The dispatch path is matchable but
    // no longer rendered: it earned its keep as orientation, not as a
    // per-row caption. tabindex -1: rows are reached with ↑/↓, which keeps
    // the panel's tab cycle short enough to contain (see _buildPalette).
    // option/aria-selected is how that selection reaches assistive tech.
    const row = E(
      "a",
      {
        class: "cmdk-row",
        href: page.href,
        role: "option",
        "aria-selected": "false",
        tabindex: "-1",
      },
      [
        this._sectionIcon(page.icon, 15),
        E(
          "span",
          { class: "cmdk-title" },
          // A tab named after its parent is the page the parent opens.
          page.parent && page.parent !== page.title
            ? [
                E(
                  "span",
                  { class: "cmdk-parent" },
                  this._palMark(page.parent, parentRanges),
                ),
                E(
                  "span",
                  { class: "cmdk-label" },
                  this._palMark(page.title, ranges),
                ),
              ]
            : this._palMark(page.title, ranges),
        ),
        page.group
          ? E(
              "span",
              { class: "cmdk-group-name" },
              this._palMark(page.group, groupRanges),
            )
          : "",
      ],
    );
    if (page.isLogout)
      row.addEventListener("click", () => {
        // Same contract as header.ut's delegated a.sidebar-logout listener:
        // logging out drops the cached sidebar and suppresses re-caching.
        window.shadcnSuppressSidebarCache = true;
        try {
          sessionStorage.removeItem("shadcn.sidebar.cache");
        } catch (e) {}
      });
    else
      // Remember the pick, then let the click navigate (router or full
      // load) untouched.
      row.addEventListener("click", () => this._palRecordRecent(page.path));
    return row;
  },

  /**
   * Subsequence scorer: every query char must appear in order; consecutive
   * runs and word/segment starts weigh extra. Title hits rank first, then a
   * tab's parent — scored alone so its tabs tie and keep menu order, or
   * paired with the title when the query splits on a space — then the
   * section label, then the language-neutral path, where each query word
   * (split on spaces or "/") lands inside one segment, in path order, so a
   * lone word can't scatter across segments. Title, parent and label hits
   * highlight the field they matched; a path hit ranks without highlighting.
   */
  _palScore(q, title, path, group, parent) {
    const t = this._palSub(q, title.toLowerCase());
    if (t) return { score: t.score + 10, ranges: t.ranges, groupRanges: null };
    if (parent) {
      const low = parent.toLowerCase();
      const pt = this._palSub(q, low);
      if (pt)
        return {
          score: pt.score + 7,
          ranges: null,
          groupRanges: null,
          parentRanges: pt.ranges,
        };
      const words = q.split(/\s+/);
      for (let i = 1; i < words.length; i++) {
        const head = this._palSub(words.slice(0, i).join(" "), low);
        const tail =
          head && this._palSub(words.slice(i).join(" "), title.toLowerCase());
        if (tail)
          return {
            score: head.score + tail.score + 7,
            ranges: tail.ranges,
            groupRanges: null,
            parentRanges: head.ranges,
          };
      }
    }
    // On a localized instance the section label is the only group name the
    // user ever sees: querying the translated 'Network' must reach its rows.
    const g = group ? this._palSub(q, group.toLowerCase()) : null;
    if (g) return { score: g.score + 5, ranges: null, groupRanges: g.ranges };
    const p = this._palPath(q, String(path || "").toLowerCase());
    return p ? { score: p.score, ranges: null, groupRanges: null } : null;
  },

  _palPath(q, low) {
    const words = q.split(/[\s/]+/).filter(Boolean);
    const segments = low.split("/");
    let at = 0;
    let score = 0;
    for (const word of words) {
      let hit = null;
      for (; at < segments.length; at++) {
        hit = this._palSub(word, segments[at]);
        if (hit) break;
      }
      if (!hit) return null;
      score += hit.score;
    }
    return words.length ? { score } : null;
  },

  _palSub(q, low) {
    let ti = 0;
    let score = 0;
    let run = 0;
    const ranges = [];
    for (let qi = 0; qi < q.length; qi++) {
      const c = q[qi];
      if (c === " ") {
        run = 0;
        continue;
      }
      const at = low.indexOf(c, ti);
      if (at < 0) return null;
      run = at === ti && qi > 0 ? run + 1 : 1;
      score +=
        run + (at === 0 || low[at - 1] === " " || low[at - 1] === "/" ? 3 : 0);
      if (ranges.length && ranges[ranges.length - 1][1] === at)
        ranges[ranges.length - 1][1] = at + 1;
      else ranges.push([at, at + 1]);
      ti = at + 1;
    }
    return { score: score - low.length * 0.02, ranges };
  },

  _palMark(title, ranges) {
    // Case folding can change string length ("İ" → "i̇"), skewing offsets
    // into the original — skip highlighting rather than mis-slice.
    if (!ranges || title.toLowerCase().length !== title.length) return [title];
    const out = [];
    let last = 0;
    ranges.forEach(([a, b]) => {
      if (a > last) out.push(title.slice(last, a));
      out.push(E("mark", {}, [title.slice(a, b)]));
      last = b;
    });
    if (last < title.length) out.push(title.slice(last));
    return out;
  },

  _palSelect(row) {
    const prev = this.palList.querySelector(".is-selected");
    if (prev) {
      prev.classList.remove("is-selected");
      prev.setAttribute("aria-selected", "false");
    }
    row.classList.add("is-selected");
    row.setAttribute("aria-selected", "true");
    this.palInput.setAttribute("aria-activedescendant", row.id);
  },

  _palMove(delta) {
    const rows = [...this.palList.querySelectorAll(".cmdk-row")];
    if (!rows.length) return;
    const current = rows.findIndex((r) => r.classList.contains("is-selected"));
    const next = rows[(current + delta + rows.length) % rows.length];
    this._palSelect(next);
    next.scrollIntoView({ block: "nearest" });
  },

  renderBreadcrumb(branch, branchUrl) {
    const crumb = document.getElementById("topbar-breadcrumb");
    if (!crumb) return;

    crumb.innerHTML = "";

    const dp = L.env.dispatchpath || [];
    const activeSection = dp[1] || "";
    const activePage = dp[2] || "";

    const ch = branch.children || {};
    const sectionNode = ch[activeSection];
    const pageNode =
      sectionNode && sectionNode.children
        ? sectionNode.children[activePage]
        : null;

    if (sectionNode) {
      crumb.appendChild(
        E("span", { class: "breadcrumb-item" }, [_(sectionNode.title)]),
      );
    }
    if (pageNode) {
      crumb.appendChild(
        E("span", { class: "breadcrumb-sep" }, [
          this._iconFile("chevron-right", 14),
        ]),
      );
      crumb.appendChild(
        E("span", { class: "breadcrumb-item active" }, [_(pageNode.title)]),
      );
    }
  },

  /** Recursive tab rows for menu levels below the sidebar’s two. */
  renderTabMenu(tree, url, level) {
    const container = document.getElementById("tabmenu");
    if (!container) return;

    const l = (level || 0) + 1;
    const ul = E("ul", { class: "tabs" });
    const children = ui.menu.getChildren(tree);
    let activeNode = null;

    if (children.length === 0) return;

    const dp = L.env.dispatchpath || [];

    children.forEach((child) => {
      const isActive = dp[l + 2] == child.name;
      const activeClass = isActive ? " active" : "";
      const className = "tabmenu-item-%s %s".format(child.name, activeClass);

      ul.appendChild(
        E("li", { class: className }, [
          E("a", { href: L.url(url, child.name) }, [_(child.title)]),
        ]),
      );

      if (isActive) activeNode = child;
    });

    container.appendChild(ul);
    container.style.display = "";

    if (activeNode)
      this.renderTabMenu(activeNode, url + "/" + activeNode.name, l);

    return ul;
  },

  initUciIndicator() {
    const original = ui.changes && ui.changes.setIndicator;
    if (!original) return;
    ui.changes.setIndicator = function (n) {
      original.call(this, n);
      document
        .querySelectorAll('[data-indicator="uci-changes"]')
        .forEach((el) => {
          el.setAttribute("data-count", n || 0);
        });
    };
  },
});
