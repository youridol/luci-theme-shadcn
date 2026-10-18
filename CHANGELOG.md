# Changelog

All notable changes to `luci-theme-shadcn`. Versions follow the `Makefile`'s
`PKG_VERSION`; the `.ipk` release suffix is `PKG_RELEASE`.

## 0.9.0 — unreleased

The Overview page becomes an operations dashboard, and the shell is realigned
to the admin layout it is modelled on.

### Added

- **Overview dashboard** (`admin/status/overview`). Six metric tiles (WAN
  status, online terminals, connection count, today's traffic, live rate,
  temperature), then three sections: lines (per-interface rate and state),
  resources (CPU with per-core bars, memory and storage, system info), and
  traffic (per-port sparklines, hourly bars, top hosts, protocol split). Native
  sections are hidden but reachable through an escape hatch. Fast path polls at
  5 s (1–60 s selectable), slow path at 60 s.
- **Anomaly banner** with three tiers, judged in the backend against raw
  numerators — connections, memory, temperature, load, and the share of
  hardware-offloaded connections. Every row states the threshold it crossed.
- **One-click diagnostics**: gateway, DNS, and internet reachability plus the
  verdict, on demand rather than polled.
- **Dashboard Alerts settings page** (`System → Dashboard Alerts`). Thresholds
  live in `/etc/config/shadcn-dashboard`; the form shows each built-in default
  as the placeholder and removes an option when a field is cleared, so a future
  default change still reaches installs that never configured anything. If the
  config file is absent, the page explains that and offers to recreate it —
  UCI cannot create a missing config, so the backend gained
  `shadcn.createConfig`.
- **Sampler** (`/etc/init.d/shadcn-dashboard`, procd, nice 19). Keeps 1440
  one-minute points in tmpfs for the look-back charts.
- `shadcn.board()`: hostname, firmware, kernel, target, architecture and CPU
  model, read once and cached. Surfaced on the dashboard as the 系统信息 card.
- **Uptime** in the fast sample, shown as 运行时长 — the first thing to check
  when deciding whether a reboot just happened.

### Changed

- **Root font size is 16px**, with body copy at 14px (was 14px root
  throughout). Every shell dimension is expressed in rem, so the old root made
  the whole chrome 12.5% smaller than the reference layout: a `16rem` sidebar
  measured 224px instead of 256px, the `h-16` header 49px instead of 64px. The
  sidebar, both headers, card radius and content inset now match the reference;
  text density is unchanged.
- **Content is capped at 80rem and centred** (`max-w-7xl`), so a wide window no
  longer stretches every reading line to the full width. Applied to
  `#maincontent`'s children, not the scroll container, so the scrollbar stays
  at the window edge.
- Sidebar and card headers are 64px (was 49 / 42px).

### Removed

- **The light colour scheme.** `data-darkmode="true"` is set unconditionally
  before paint and `shadcn.theme` is deleted from localStorage rather than
  read, so a browser that once chose light lands on dark with no flash.
- **All gradients**, including the token helpers that produced them.
- `<img>`-based icons on the shell: every icon is a mask box tinted with
  `currentColor`, so one asset serves every tone.

### Fixed

- Integer division silently zeroed the percentage of conntrack, memory and
  storage use, so those alerts could never fire.
- `caps` did not report the CPU count, which made the load alert unreachable.
- Hourly traffic chart drew two oversized bars before a full day of samples;
  it now uses a fixed 24-slot axis with gaps for empty hours.
- DNS diagnostics read the resolver's own `Address:` line as the answer.
- The internet reachability probe used a resolver that is dropped on some
  lines, reporting "no internet" on a healthy connection.

### Notes

- `ucode` on this build has no `for…of`, no `Math`, no `isNaN`, and its regex
  rejects the `m` flag and `(?:…)` non-capturing groups — the latter fails
  loudly enough to take down every backend method. See
  [.dev/docs/dashboard.md](.dev/docs/dashboard.md) for the full list.
- Budgets in `.dev/tests/build-output.test.js` guard asset growth; they were
  re-based after the dark-only work removed a colour scheme's worth of bytes.

## 0.8.0

- Sidebar layout realignment (v0.7.0 line) concluded: floating inset sidebar,
  grouped navigation, collapsible to icons.
- Client-side router between LuCI view pages, with a full-load fallback.
- On-demand per-page patches for third-party pages.

## 0.7.0

- Reworked the shell around shadcn/ui design language; sidebar replaces the
  horizontal menu.
