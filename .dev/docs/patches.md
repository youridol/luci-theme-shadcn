# On-demand page patches

Third-party LuCI app/page compatibility fixes live one file per page in `src/media/patches/<page>.css`, where `<page>` is the `[data-page="..."]` value (request path segments joined by `-`). They are **not** bundled into `main.css`; `header.ut` links only the ones that match the page being rendered.

## Plain CSS, by design

**Patches are the one place that writes plain CSS instead of `@apply`.** Each is its own Rollup entry, so `@reference "../main.css";` + `@apply` made every file carry its own `@property` boilerplate (7 patches: 6,491 B → 1,083 B once rewritten).

Write narrow `[data-page]`/class-scoped overrides with native declarations, still reaching for theme values through the `:root` custom properties (`var(--panel-bg)`, `var(--foreground-a30)`, `var(--shadow-sm)`, …) rather than hardcoded colours or magic numbers. A value a patch needs but `:root` doesn't expose gets added to `STRUCTURE` in `scripts/gen-tokens.js` (that is why `--shadow-sm` exists), not inlined. CSS Nesting still works, since it needs no Tailwind processing.

The `@reference` + `@apply` route still _compiles_ for theme-repo patches and has real upsides — build-time validation (a typo'd utility fails the build; a typo'd `var()` fails silently at runtime) and the shared `dark:`/`md:`/`hover:` vocabulary — native is the default for the size numbers above, not a hard gate. App-shipped patches bypass the build entirely and have always been plain-CSS-only.

Before writing a patch, ask whether the symptom is really page-specific. Something that breaks the same way on any app's page is a theme bug: fix it in the core CSS so every page gets the fix, and keep globally-applicable chrome tweaks (e.g. icon opacity) in `_shared.css`, not here. A patch is for what is genuinely local to one app — or, for a preference the theme should not adopt for everyone, the global `admin.css` case below.

## Discovery and matching

`vite.config.ts` builds each patch as its own Rollup entry → `htdocs/luci-static/shadcn/patches/<page>.css`.

`header.ut` discovers installed patches at render time via `fs.lsdir()` (no build-time allow-list) and matches them against the cumulative path-segment prefixes of the current page: a patch applies to its page and all subpages, matching only on real segment boundaries so a prefix never leaks onto a lookalike sibling app. All matching patches load (sorted, so a shorter/general name precedes a longer/specific one, which then cascades on top) — this also lets dynamically generated pages (e.g. one page per contact/device) be covered by a patch named after their fixed prefix.

Because discovery is at render time, **any package — not just the theme — may drop a `<page-prefix>.css` into `luci-static/shadcn/patches/`** and it takes effect immediately, no theme rebuild required.

**`patches/admin.css` is therefore the global patch.** Every admin page's path starts with `admin`, so the shortest prefix matches all of them; sorting loads it first and the page-specific patches cascade on top (the login page loads no patches at all). That is how a user carries a preference the theme should not ship for everyone — a CJK-friendly monospace UI font, say — without forking it: write the file by hand on the device at `/www/luci-static/shadcn/patches/admin.css`. The theme neither builds nor installs that path, so a theme upgrade leaves it alone.

`PATCH_ALIASES` in `vite.config.ts` can duplicate one built payload (CSS and JS) under several page names when unrelated pages share it. It is currently empty — the log viewer ships only `patches/admin-status-logs.js`, whose prefix covers both log tabs on every supported release; its CSS is core-page styling and lives in `components/_syslog.css` inside `main.css`, where the `.syslog-view` markup contract is deliberately global so other packages can reuse the viewer. `_`-prefixed files in `patches/` are `@import`-only fragments, never entries.

## JS payloads

The same `lsdir()` sweep loads `patches/<page>.js` as `<script defer>` after the patch stylesheets (theme-owned sources in `src/resource/patches/`, Terser-compressed to `shadcn/patches/`; third-party packages may drop plain scripts the same way).

A JS patch must register `window.luciPatches[<stem>] = { mount, unmount }` and mount itself once at eval: the [client-side router](router.md) drives it across same-document navigations and a plain script would otherwise keep running on pages that are gone. `header.ut` also emits every installed patch file as `body[data-patches]` and marks its own `<link>`/`<script>` tags `data-luci-patch` so the router can enable/disable them per page.

Patch sources sit under `src/` (`src/media/patches/`, `src/resource/patches/`), inside Tailwind's automatic source scan, so a plain string like `createElement("table")` becomes a `.table` candidate emitted into `main.css`. `main.css` therefore excludes both patch directories with `@source not`; keep them excluded when adding a patch that builds DOM.

## `admin-status-overview` — online-host drawer

The Overview page renders `#status_leases` with each host as plain text. This patch turns the host name and the IPv4 cell into buttons that open a right-hand drawer listing that host's live connections (13 columns: app, protocol, line, external address, domain, source port, destination, destination port, up/down rate, cumulative up/down, state).

Data comes from the theme's own rpcd object (`root/usr/share/rpcd/ucode/shadcn.uc` + `root/usr/share/ucode/shadcn/conntrack.uc`, ACL in `root/usr/share/rpcd/acl.d/shadcn.json`), **not** from `luci-app-trafficctl` — that package only offers per-host totals. The backend parses `/proc/net/nf_conntrack`, fingerprints the app by destination port, resolves domains from local dnsmasq leases, and computes rates as byte deltas between two samples.

Two rpcd details are load-bearing and cost time to find:

- Each method needs `args: { name: 'String' }`. Writing a lowercase variable name there still shows a `String` signature, but **drops the argument** — `req.args` stays empty. Only the `String` literal works.
- From the browser, call it with `rpc.declare({ object, method, params: [...] })` and **positional** arguments. `L.require('fs').exec('/ubus', ...)` is rejected with `PermissionError`; `rpc.declare` is the path that carries the session.

The drawer polls on its own timer (default 1 s, presets 1–5 s in the toolbar). Rates read `—` on the first sample by design — one fetch can only yield cumulative totals. Connections the kernel does not account bytes for show `—` rather than a fake `0 B/s`.

Three backend details cost time to find, and all three fail *silently* rather than erroring:

- rpcd `args` needs the literal `'String'`. A lowercase variable name still renders a `String` signature but drops the argument, leaving `req.args` empty.
- ucode has **no function hoisting**. A forward call throws at runtime and the caller swallows it, so a correct lease file produced an empty name map. Keep `loadLeases()` below `lanAddress()`.
- `match()` returns an array or `null`, not a boolean. `inLan = match(...)` then `if (inLan && ...)` behaves inconsistently; compare against `null` explicitly.

## Debugging a page that suddenly loses ubus access

Never probe the daemon with `rpcd -h` on the device. BusyBox's `rpcd` treats `-h` as a request that **blocks**, leaving a process stuck on the ubus socket; every later `uci/get` from the browser then fails with `ubus code 6: 没有权限` on many unrelated pages, which looks exactly like a broken ACL. If that symptom appears:

```sh
ps | grep "[r]pcd"      # more than one rpcd line means a stuck probe
```

Kill the extra PIDs by number (`pkill -f` does not match them, since the process name is just `rpcd`), then `/etc/init.d/rpcd restart`. Confirm with one rpcd process and `ubus call uci get '{"config":"luci"}'` succeeding.

To tell a theme regression from this, remove the theme's rpcd files and re-test: if `uci/get` still fails, the cause is environmental, not the ACL.

## Adding / removing a theme patch

Create the file, run `pnpm build`, verify the built file is small. Removal is symmetric — delete the file, rebuild.
