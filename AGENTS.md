# AGENTS.md

Guidance for coding agents working in this repository.

**Read [CLAUDE.md](CLAUDE.md) — it is the single source of truth** (commands, layout, and the rules that bite if ignored). It is not Claude-specific; this file used to be a hand-kept copy of it and drifted.

Deep dives live in `.dev/docs/`:

- [build.md](.dev/docs/build.md) — build output map, terser options, dev-server env, Vite plugins, releases, continuous `ipk` builds
- [css.md](.dev/docs/css.md) — `@apply` conventions, import order, tokens, dark mode, icons
- [patches.md](.dev/docs/patches.md) — on-demand per-page patches (CSS + JS)
- [router.md](.dev/docs/router.md) — the client-side router; read before touching navigation
- [sidebar.md](.dev/docs/sidebar.md) — sidebar/menu rendering and the anti-flash cache
- [mock-pages.md](.dev/docs/mock-pages.md) — styling third-party pages without a device

## CI

Every push builds a `.ipk` via `.github/workflows/build-ipk.yml`, pinned to `env.SDK` — that
version must match the target router, because the SDK decides `ipk` (opkg) vs `apk`. The current
target (`192.168.3.254`) is LEDE `24.10.5`, `x86/64`, `opkg`, hence `SDK: "24.10.5"`. Update it
after reflashing the router. Whole-firmware (`openwrt-build`) compilation is deliberately **not**
wired in yet. Details: [.dev/docs/build.md](.dev/docs/build.md#continuous-ipk-builds).

## Budgets & dependencies

`.dev/tests/build-output.test.js` asserts raw-transfer budgets because uhttpd serves identity
bytes: `main.css ≤ 134 KB`, `login.css ≤ 12 KB`, `menu-shadcn.js ≤ 16.5 KB`,
`sidebar-shadcn.js ≤ 5.5 KB`, `router-shadcn.js ≤ 16 KB`, plus aggregate caps for the admin
bundle (222 KB) and the login page (62 KB). These were raised for the shadcn realignment
(v0.7.0), then **lowered** after the dark-only + mask-icon work (adr/0002, adr/0006) removed a
whole colour scheme's worth of bytes — the assertion is a guard against unnoticed growth, so
adjust it only with a measured reason recorded in the commit. Patches are deliberately not
budgeted: they are on-demand payloads whose sizes are tracked in
[.dev/docs/dashboard.md](.dev/docs/dashboard.md).

`tw-animate-css` is the only added runtime dependency of the realignment. It ships its utilities
with `@utility`, which `@apply` cannot reference — see the Motion section of
[.dev/docs/css.md](.dev/docs/css.md) for the raw-shorthand pattern.
