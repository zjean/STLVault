# STL Vault redesign — Tailwind implementation plan

_Plan date: 2026-05-21_

Source: Claude Design handoff bundle (`stl/` — README, chat transcript, `STL Vault.html` ~1.7k lines, `app.jsx`, `tweaks-panel.jsx`, `icons.jsx`).

The handoff is an HTML/JSX prototype using runtime Babel + CSS variables. The job is to **recreate it pixel-perfectly inside our existing React/Vite frontend** using Tailwind (already installed, v3.4). The design author committed to a Tailwind migration in the chat — this doc is that migration.

## Scope

**In:**
- Full visual redesign of all existing views: Library (sidebar + model grid + detail drawer), Settings.
- Theme tokens (warm graphite dark + light) wired to Tailwind via CSS vars.
- Geist / Geist Mono fonts.
- Mobile responsive behavior: sidebar drawer + scrim, detail bottom-sheet, FAB.
- **React Router** (react-router-dom v6) — `/` library, `/settings`. Sets up the URL surface so Tags + Recent can drop in cleanly later.

**Deferred to a follow-up cycle (not in this plan):**
- **Tags** page (cloud + detail) and **Recent** page (sparkline + grouped activity). The design defines them; we'll land them after the core redesign is shipped. Sidebar will show their nav items as disabled/coming-soon during the redesign.

**Out (explicit YAGNI):**
- The **Tweaks panel** (`tweaks-panel.jsx`). That's a design-tool affordance — theme/accent/density/view/viewport sim — and the user already noted in chat that production doesn't need it. We'll surface only the user-facing subset: dark/light toggle (in settings), nothing else.
- Accent-color picker (amber / sky / green / violet / coral). Single-accent shipped (amber/filament — matches the design's default).
- Viewport simulator. Not needed in production.
- **No new backend features**, no schema changes.

## What exists today (the gap)

Current frontend (`frontend/`):
- React 19 + Vite + Tailwind v3 + **MUI** (Material UI is mixed in heavily — Snackbar, ThemeProvider, x-tree-view, Button, Stack, etc.).
- Components: `Sidebar.tsx` (525 lines, MUI tree), `ModelList.tsx` (736 lines), `DetailPanel.tsx` (594 lines), `Settings.tsx` (197 lines), `Navbar.tsx`, `Viewer3D.tsx`, `STEPLoader.tsx`, plus `custom-bambu/` and `custom-importers/`.
- No Recent or Tags pages.
- Font: Roboto + Material Icons.
- Tailwind config has a `vault.*` color palette that's basically unused — to be replaced with semantic CSS-var-backed colors.
- `App.tsx` (1.4k lines) holds all top-level state.

**Strategy: in-place modify, not rewrite.** The codebase has well-established data flow; we change skins + add two routes/views, we don't touch business logic or service layers.

## Implementation strategy: Tailwind + CSS variables

The design defines tokens in `:root` via OKLCH CSS variables and switches via `html[data-theme="light"]`. That's the cleanest theming approach we can keep — Tailwind just references the vars.

### `tailwind.config.js` (updated)

```js
extend: {
  colors: {
    bg:         'oklch(var(--bg) / <alpha-value>)',
    'bg-2':     'oklch(var(--bg-2) / <alpha-value>)',
    'bg-3':     'oklch(var(--bg-3) / <alpha-value>)',
    surface:    'oklch(var(--surface) / <alpha-value>)',
    'surface-2':'oklch(var(--surface-2) / <alpha-value>)',
    border:     'oklch(var(--border) / <alpha-value>)',
    'border-soft':'oklch(var(--border-soft) / <alpha-value>)',
    fg:         'oklch(var(--fg) / <alpha-value>)',
    'fg-2':     'oklch(var(--fg-2) / <alpha-value>)',
    'fg-3':     'oklch(var(--fg-3) / <alpha-value>)',
    accent:     'oklch(var(--accent) / <alpha-value>)',
    'accent-soft':'oklch(var(--accent-soft) / <alpha-value>)',
    'accent-fg':'oklch(var(--accent-fg) / <alpha-value>)',
    danger:     'oklch(var(--danger) / <alpha-value>)',
    'danger-soft':'oklch(var(--danger-soft) / <alpha-value>)',
    success:    'oklch(var(--success) / <alpha-value>)',
  },
  fontFamily: {
    sans: ['Geist', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
    mono: ['"Geist Mono"', 'ui-monospace', '"SF Mono"', 'Menlo', 'monospace'],
  },
  borderRadius: { 'card': '14px', 'pill': '999px' },
  boxShadow: {
    'soft':   '0 1px 0 oklch(1 0 0 / 0.04) inset, 0 1px 2px oklch(0 0 0 / 0.3)',
    'lifted': '0 1px 0 oklch(1 0 0 / 0.04) inset, 0 8px 24px oklch(0 0 0 / 0.35)',
    'drawer': '0 1px 0 oklch(1 0 0 / 0.05) inset, 0 24px 60px oklch(0 0 0 / 0.55)',
  },
}
```

Vars store the three OKLCH channels separately (e.g. `--bg: 0.155 0.005 60`) so Tailwind's `<alpha-value>` placeholder works for opacity utilities (`bg-bg/50`).

### Token CSS (new file: `frontend/styles/theme.css`)

A small CSS file imported once. Holds:
- `:root` token values (dark default) + `html[data-theme="light"]` overrides.
- `@font-face` for Geist (via Google Fonts CSS link in `index.html`).
- A tiny `@layer components` block for repeated atoms the design defines: `.btn`, `.btn-primary`, `.btn-ghost`, `.btn-subtle`, `.icon-btn`, `.tag` chip, `.input`, `.select`, `.segmented`. These compile to `@apply` directives. Keeps JSX readable instead of 12-class utility soup per button.
- A `@media (max-width: 900px)` block for the sidebar-drawer + bottom-sheet behavior. We **skip container queries** — they were a design-tool affordance for the viewport simulator; in production the browser viewport is the actual container, so plain media queries are enough.

### Imports

- `frontend/index.tsx` already imports `index.css`. Add `@tailwind base; @tailwind components; @tailwind utilities;` to `index.css` (verify — may already be there via PostCSS pipeline added in PR #17) and `@import './styles/theme.css';` at top.
- `frontend/index.html`: swap Roboto link for Geist + Geist Mono. Drop Material Icons (lucide-react covers it).

## MUI: keep or strip?

**Decision: minimize MUI in views being redesigned, keep where it costs more to remove than it saves.**

- **Strip:** `@mui/x-tree-view` (sidebar's library tree — redesigned as plain divs), `@mui/material` Stack/Button/Container/IconButton/Badge in `Sidebar.tsx` and `Settings.tsx` (replaced by Tailwind divs/buttons).
- **Keep for now:** `Snackbar` + `Alert` in `App.tsx` (the design has its own toast styling but the MUI snackbar is small and works — replacing it is a separate cleanup if it ever matters).
- **Keep `ThemeProvider` + `CssBaseline`** only as long as we still render any MUI; once Snackbar is the only thing left, ThemeProvider can stay minimal.

Document this trade-off as a follow-up in the PR description.

## Component-by-component mapping

| Design region (in `STL Vault.html`) | Current file | Action |
|---|---|---|
| `<Sidebar>` — logo, nav (Library / Recent / Tags / Settings), library tree, storage card | `components/Sidebar.tsx` | Rewrite layout, drop MUI tree, replace with plain recursive `<TreeRow>`. Add `view` prop ("library" / "recent" / "tags" / "settings"). Library section gets collapse toggle. |
| `<MainHeader>` breadcrumb + actions + mobile burger | `components/Navbar.tsx` | Repurpose as `<TopBar>` — breadcrumbs, search via toolbar below, action buttons (upload, import, sort, view toggle live here for library view). |
| Search / sort / segmented (grid/list) toolbar | inline in `App.tsx` / `ModelList.tsx` | Extract into `components/Toolbar.tsx`. |
| Model grid + list mode + selection bar | `components/ModelList.tsx` | Replace markup with new `.model-card` / `.format-badge` / `.card-check` / `.tag` styling. Selection bar = sticky `.selection-bar`. |
| Empty state | inline | New `<EmptyState>` component. |
| Detail drawer + 3D viewer area | `components/DetailPanel.tsx` | Restyle. Keep existing `Viewer3D` inside the `.viewer` wrapper. Tag chips = `.tags-input` styled, mobile bottom-sheet via media query. |
| Settings (slicer cards, API host, Bambu sign-in) | `components/Settings.tsx` | Rewrite with `.slicer-grid` + `.slicer-card` + `.info-banner`. Integrate existing `custom-bambu` section as a settings card. |
| Tags page (cloud + detail) | _deferred_ | Sidebar nav item stubbed (disabled state) during redesign. Implemented in a follow-up cycle. |
| Recent page (sparkline + grouped lists) | _deferred_ | Sidebar nav item stubbed (disabled state). Follow-up cycle. |
| Drag-and-drop upload dropzone overlay | inline in `App.tsx` | Style only — keep existing handlers. |
| Upload toast | currently MUI Snackbar | Keep MUI Snackbar; restyle later if needed. |
| Context menu on right-click | not currently present | Skip for v1 (was a polish item in the design — bookmark for follow-up). |

## App routing

**Decision: introduce `react-router-dom` v6.** Settings is currently a `isSettingsOpen` flag in `App.tsx`. The redesign promotes Settings to a peer view of Library, and Tags/Recent will land on their own routes later (`/tags/rpg` deep links are part of the design). Putting the router in now during the rewrite is cheaper than retrofitting later.

Routes for this redesign:
- `/` — Library (current folder selection via search params: `/?folder=<id>`, `/?model=<id>` for an open detail).
- `/settings` — Settings page.
- `/recent`, `/tags`, `/tags/:tagName` — reserved; sidebar nav items rendered disabled with a "Coming soon" affordance until the follow-up cycle.

Implementation notes:
- `BrowserRouter` at `index.tsx`. App-shell pattern: top-level `<Routes>` inside `App.tsx`, sidebar/topbar always rendered.
- `useNavigate()` replaces the `setIsSettingsOpen(true)` callbacks.
- Folder + selected-model state moves to URL search params so back/forward works naturally on mobile.
- Bundle cost: ~10 KB gzipped, acceptable.

## Responsive behavior

Plain Tailwind media queries (no container queries plugin):
- `< 900px` (use `max-lg:` via `screens` extension or `@media` in `theme.css`):
  - Sidebar becomes absolute drawer with scrim.
  - Detail panel becomes bottom-sheet (`fixed inset-x-0 bottom-0 rounded-t-2xl`).
  - Header burger button visible.
  - FAB visible bottom-right for upload.
- The existing `useMediaQuery("(min-width: 1024px)")` in `App.tsx` stays — we'll align its breakpoint to 900px to match the design.

## Implementation phases (PR breakdown)

Each phase is one PR, squash-merged, branch `feat/redesign-<phase>`. CI must pass before next phase opens.

1. **`feat/redesign-foundation`** — tokens + fonts + Tailwind config + theme.css + react-router-dom install. Wrap app in `BrowserRouter`. No visible component change yet (or trivial: body bg + text color). Verifies the wiring without touching components.

2. **`feat/redesign-sidebar`** — replace `Sidebar.tsx` markup + drop MUI tree. Library + nav items (Recent/Tags disabled) + storage card. Mobile drawer behavior. Wire nav items to `useNavigate`.

3. **`feat/redesign-toolbar-grid`** — header, toolbar, ModelList grid + list mode, empty state. Selection bar, format badges, hover affordances. Card right-click context menu deferred.

4. **`feat/redesign-detail`** — DetailPanel restyle, tag chip editor, viewer chrome, danger zone, bottom-sheet on mobile.

5. **`feat/redesign-settings`** — slicer cards, API host form, Bambu Cloud card. Move from modal to `/settings` route.

6. **`feat/redesign-polish`** — light theme toggle, FAB, upload dropzone overlay, any escaped MUI cleanup. Document Tweaks-panel omission. Drop `vault.*` Tailwind palette.

**Deferred (separate cycle):**
- `feat/recent-view` — new RecentView at `/recent`.
- `feat/tags-view` — TagsView + TagDetailView at `/tags` and `/tags/:tagName`.

## Verification per phase

Each PR must:
- Build clean (`npm run build`).
- Pass typecheck.
- **Browser-verify with dev-loop-verify skill** (chrome-devtools MCP): load the dev server, exercise the affected surface, screenshot before/after. Compare against the relevant region of `STL Vault.html` rendered as reference (the prototype file gets opened in a separate tab when needed — design said don't screenshot unless asked, but for pixel-perfect verification we do open it).
- Mobile check: simulate viewport ≤390px wide, confirm drawer + bottom-sheet behaviors.

## Risks and trade-offs

- **MUI mixed-mode.** Sidebar/tree currently MUI; removing means custom drag/drop, custom rename inline editor, custom create-folder flow. **Mitigation:** the design's tree is simpler (no DnD-to-reorder, just click-to-select + inline ✎/+/× icons on hover). Carry over our existing DnD-into-folder logic on the new plain rows. Inline editing = controlled input, ~30 lines.
- **OKLCH browser support.** Modern Chromium/Firefox/Safari all support `oklch()`. Fallback not needed for our deploy target (self-hosted, modern browsers).
- **Geist font weight.** Google Fonts serves Geist; license clear (OFL). Page weight similar to Roboto.
- **Container queries omitted.** If we ever need an embed/iframe context where the app container is narrower than the viewport, we'd need to revisit. Not a real concern today.
- **Big surface, multi-PR.** Each phase is independently reviewable; main never breaks. We pause between phases to recalibrate.
- **Router migration touches App.tsx top state.** Folder + selected-model state moving to URL search params is a small but non-cosmetic change. Folded into the foundation PR so the rest can lean on it.

## What lands first

Phase 1 (`feat/redesign-foundation`): theme.css, tailwind.config update, fonts swap, `react-router-dom` install + `BrowserRouter` wrap, port `isSettingsOpen` → `/settings` route. Small enough to review in one sitting, gives every later phase a baseline to lean on.
