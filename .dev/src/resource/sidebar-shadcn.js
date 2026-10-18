"use strict";
"require baseclass";

// Legacy key. The theme shipped a light/dark/device switch until
// .dev/docs/adr/0002-dark-only.md; a stored value is deleted on start so a
// stale preference cannot outlive the switch it belonged to.
const THEME_KEY = "shadcn.theme";
const SIDEBAR_KEY = "shadcn.sidebar";

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

  // One scheme only. header.ut sets data-darkmode before paint; this drops the
  // key the removed three-way switch used to write.
  initTheme() {
    try {
      localStorage.removeItem(THEME_KEY);
    } catch (e) {}
    document.documentElement.setAttribute("data-darkmode", "true");
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

    const collapsed = localStorage.getItem(SIDEBAR_KEY) === "true";
    sidebar.setAttribute("data-collapsed", collapsed);

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

    this._initAccordion();
    this._initCollapsedPopover();
  },

  toggleCollapse() {
    const sidebar = document.getElementById("sidebar");
    if (!sidebar) return;
    const next = sidebar.getAttribute("data-collapsed") !== "true";
    sidebar.setAttribute("data-collapsed", next);
    document.documentElement.setAttribute(
      "data-sidebar-collapsed",
      next ? "true" : "false",
    );
    document.documentElement.setAttribute("data-sidebar-anim", "");
    localStorage.setItem(SIDEBAR_KEY, next);

    this._hideCollapsedPopover();

    if (next) {
      document
        .querySelectorAll(".sidebar-accordion-item[data-open='true']")
        .forEach((item) => {
          this._closeAccordionItem(item);
        });
    }
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

  _initAccordion() {
    document.addEventListener("click", (e) => {
      const trigger = e.target.closest(".sidebar-nav-parent");
      if (!trigger) return;

      const sidebar = document.getElementById("sidebar");
      if (sidebar?.getAttribute("data-collapsed") === "true") return;

      const item = trigger.closest(".sidebar-accordion-item");
      if (!item) return;

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
