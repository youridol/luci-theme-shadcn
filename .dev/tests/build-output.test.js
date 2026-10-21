import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const output = resolve(import.meta.dirname, "../../htdocs/luci-static");
const read = (path) => readFileSync(resolve(output, path), "utf8");
const bytes = (path) => statSync(resolve(output, path)).size;

test("pruned login.css keeps every consumed variable resolvable", () => {
  const css = read("shadcn/login.css");
  const declared = new Set(
    [...css.matchAll(/[{;](--[\w-]+):/g)].map((m) => m[1]),
  );
  const registered = new Set(
    [...css.matchAll(/@property\s+(--[\w-]+)/g)].map((m) => m[1]),
  );
  // sysauth.ut declares it inline at render time.
  const injected = new Set(["--login-bg-image"]);

  const unresolvable = [];
  for (const [, name, delim] of css.matchAll(/var\(\s*(--[\w-]+)\s*([,)])/g))
    if (
      delim !== "," &&
      !declared.has(name) &&
      !registered.has(name) &&
      !injected.has(name)
    )
      unresolvable.push(name);
  assert.deepEqual([...new Set(unresolvable)], []);

  for (const adminOnly of ["--sidebar-bg:", "--terminal-foreground:"])
    assert.ok(!css.includes(adminOnly), `${adminOnly} should be pruned`);
  assert.ok(
    css.includes("-webkit-backdrop-filter"),
    "prefixes must survive the prune",
  );
});

// uhttpd serves identity bytes, so raw size is what every cold load pays.
// Set 2026-09 from main 129213, login 10521, menu 15859, router 15771,
// sidebar 6107, Inter latin 48256, logo 258.
// Raised 2026-10 for the shadcn realignment: the official token set adds the
// card/popover/accent/sidebar-* surfaces (main +~3 KB) and tw-animate-css
// brings the official enter/exit keyframes. The budget stays an assertion, not
// a licence to grow — raise it again only with a measured reason.
//
// Re-based 2026-10 after the dark-only + inline-icon work (adr/0002, adr/0006).
// That work REMOVED bytes, so these limits were lowered to keep the assertion
// tight around the new reality rather than leaving 15 KB of silent headroom:
//
//   measured          limit
//   main.css  130937  134000   (was 145000; the light token set and its
//                              alpha ladder are gone)
//   login.css  11465   12000   (was  20000)
//   menu       15989   16500   (was  17500; icon boxes carry a CSS custom
//                              property instead of an <img src>)
//   sidebar     5225    5500   (was   6500)
//   admin total 216178 222000  (was 232500)
//   login total  59983  62000  (was  69000)
//
// router stays at 16000: it is 15771, so that is the one budget still doing
// real work. Patches are deliberately NOT budgeted here — they are on-demand
// payloads that a given page never loads twice, and .dev/docs/dashboard.md
// tracks their measured sizes instead.
test("production assets stay within raw-transfer budgets", () => {
  const main = bytes("shadcn/main.css");
  const login = bytes("shadcn/login.css");
  const menu = bytes("resources/menu-shadcn.js");
  const router = bytes("resources/router-shadcn.js");
  const sidebar = bytes("resources/sidebar-shadcn.js");
  const tableSort = bytes("resources/table-sort.js");
  const font = bytes("shadcn/inter-latin-wght-normal.woff2");
  const logo = bytes("shadcn/images/logo.svg");

  // 138,000 = 134,000 + the sub-drawer CSS (~1,857 B: panel, head, link, the
  // slide transition). Raised with a measured reason per the policy above —
  // the feature is a new surface, not a refactor that should have been free.
  assert.ok(main <= 138_000, `main.css ${main} B exceeds 138 KB`);
  assert.ok(login <= 12_000, `login.css ${login} B exceeds 12 KB`);
  // 18,500 = 16,500 + the sidebar sub-drawer (~1,983 B: lazy panel creation,
  // pointerdown/Escape dismissal, DOM build from the same ui.menu data). Only
  // paid once per page; the sidebar itself is unchanged.
  assert.ok(menu <= 18_500, `menu-shadcn.js ${menu} B exceeds 18.5 KB`);
  assert.ok(router <= 16_000, `router-shadcn.js ${router} B exceeds 16 KB`);
  // 7,600 = 5,500 + the hover-expand state machine (~680 B: pointerenter /
  // pointerleave handlers, the pinned flag, and `_applyCollapsed` writing both
  // attributes plus the animation opt-out) + the leave-grace path (~1,250 B:
  // pointer tracking, the 120 ms timer, the geometric "is the pointer on the
  // sub-drawer" test that stops the rail collapsing out from under an open
  // drawer, and the drawer's own pointerout so leaving it still schedules the
  // collapse). It buys the default-collapsed rail and a reachable sub-menu, so
  // the cost is behaviour rather than a refactor that should have been free.
  assert.ok(sidebar <= 7_600, `sidebar-shadcn.js ${sidebar} B exceeds 7.6 KB`);
  // table-sort.js is ~4.2 KB: value parser (capacity / duration / IPv4 /
  // status words), the row walk and the sort menu. It only covers tables LuCI's
  // own UIDataTable sorting does not reach, so it should stay small — if this
  // grows past 6 KB something is being reimplemented that LuCI already does.
  assert.ok(tableSort <= 6_000, `table-sort.js ${tableSort} B exceeds 6 KB`);
  // 234,000 = 230,000 + the 2026-10 component-consistency pass (main.css
  // 134,657 → 136,765, +2,108 B). What that bought, measured:
  //   - focus-visible ring on the whole button family (~330 B): buttons were
  //     the only keyboard-reachable control in the theme with no focus state;
  //   - success / info button variants and the destructive-strong pairing
  //     (~410 B): save and apply used to render as two weights of the same grey;
  //   - badge icon sizing and the shared tint contract (~260 B);
  //   - the `:has(> svg | img)` icon inset from the official spec (~350 B).
  // Every per-file limit above still passes; this is the cross-check that the
  // total has not drifted silently, so it is raised by the measured amount and
  // no more.
  assert.ok(
    main + menu + router + sidebar + tableSort + font <= 234_000,
    "admin assets exceed 234 KB",
  );
  assert.ok(login + font + logo <= 62_000, "login assets exceed 62 KB");
});
