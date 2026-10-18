# CSS conventions

Style with TailwindCSS v4 `@apply`, using CSS Nesting (`&:hover`, `&[disabled]`, `.parent &`, etc.) for scoped selectors — this is the dominant pattern across every component file. Fall back to raw CSS declarations only when `@apply` can't express the rule: custom properties, `@keyframes`/`animation`/`filter`, `clip-path`, `backdrop-filter`, and inline SVG data-URI backgrounds. The single deliberate exception is `patches/*.css`, plain CSS by design — see [patches.md](patches.md).

## Import order

`main.css` import order is meaningful (later imports win the cascade): `_tokens.css` → `_base.css` → `_layout.css` → `components/_*.css` → `_utilities.css` → `_shared.css`. New component styles get their own `components/_name.css`, imported before `_utilities.css`. Third-party app patches are **not** bundled into `main.css` — they load on demand per page.

Built CSS keeps Tailwind's native `@layer` structure. Theme partials (`_base.css`, `components/*`, `_utilities.css`, …) are plain unlayered CSS — organization comes from the file split, never wrap rules in `@layer`. Unlayered partials outrank Tailwind's layered base/utilities regardless of specificity; the OKLCH tokens already gate browsers to ones with `@layer` support.

## Motion (tw-animate-css)

`main.css` imports `tw-animate-css` right after the tokens, before the theme partials. It ships `@utility` definitions (`animate-in`, `fade-in-0`, `zoom-in-95`, `slide-in-from-*`, …) plus the `enter`/`exit` keyframes and the `--animate-in`/`--animate-out` shorthands.

**`@apply` cannot reference an `@utility`.** Write the animation as a raw shorthand instead:

```css
animation: var(--animate-in);
--tw-enter-opacity: 0; /* fade-in-0 */
--tw-enter-scale: 95%; /* zoom-in-95 */
```

To make an entrance conditional (a drawer that must not replay on load), drive it with `@starting-style` rather than a bare `animation`, which would replay on every attribute change.

`_reduced-motion.css` collapses every animation to 1ms rather than `none`, because luci-base acts on `transitionend`; that still applies to these animations.

## Tokens

- **Token source**: the engine and resolver (operators, `createResolver`, CSS emission helpers) come from `@eamonxg/luci-theme-tokens` (`/engine`, `/emit`); this repo only keeps `tokens/spec.js` (derivations, baked-alpha variants) + `tokens/defaults.js` (input colors). Edit those, then run `pnpm gen:tokens`. Do not edit generated `src/media/_tokens.css` directly.
- **`_tokens.css`**: generated flat OKLCH custom properties for the single dark scheme (adr/0002) plus the shared `@theme inline` mapping. It is imported by both `main.css` and `login.css`; runtime token-based `color-mix()` and relative `oklch(from …)` are prohibited, and so is every gradient function (adr/0003).
- **Official names**: every surface/foreground token uses the shadcn/ui name (`--background`, `--card`, `--popover`, `--accent`, `--muted`, `--primary`, `--primary-foreground`, `--border`, `--input`, `--ring`, `--radius`, `--sidebar-*`), so the official docs read 1:1 against this theme. LuCI-only surfaces keep their own names (`--terminal-*`, `--progress-bar-*`, `--label-surface`, `--panel-bg`, `--login-left-bg`). `--radius` is the single radius knob (0.625rem) with the official sm/md/lg/xl/2xl multipliers; `--radius-base` is an alias for it.
- **`login.css`**: separate Vite build entry for the login page; it does **not** import `main.css`, but re-imports the generated `_tokens.css`.

## Root font size

`html` is **16px** and `body` is `0.875rem` (14px), in both `main.css` and `login.css`.

The 16px root is load-bearing: every size in the shell is expressed in rem so the layout follows it. While the root was pinned to `text-sm` (14px) the whole chrome rendered 12.5% smaller than the admin layout it mirrors — a `w-64`/`16rem` sidebar measured 224px instead of 256px, the `h-16` header 49px instead of 64px — and no later rule could fix that without hard-coding px everywhere.

Body copy is set separately at 14px, so text keeps this theme's density while the chrome around it matches the reference. When adding a rule, decide which of the two you mean:

- **chrome size** (sidebar, header, cards, spacing) → rem, follows the 16px root;
- **icon boxes** → px, because `1rem` no longer equals the old 14px and icon sizes must not drift with the root (see Icons below).

## Dark mode

There is no mode. `header.ut` sets `data-darkmode="true"` unconditionally before paint and `sidebar-shadcn.js` deletes the legacy `shadcn.theme` localStorage key instead of reading it, so a browser that once selected light lands on dark with no flash (adr/0002). `color-scheme` is `dark` and `theme-color` is the single `--background` value.

## Icons, two sources

- `.dev/src/assets/icons/` (Lucide SVGs) are referenced from CSS via the `@assets` alias as `mask-image`/`mask`, so they inherit `currentColor`.
- `.dev/public/shadcn/icons/` are SVGs referenced directly via `<img>`/JS (sidebar, menu, login, theme toggle) and copied verbatim to `htdocs/luci-static/shadcn/icons/`.
