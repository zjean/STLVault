# STLVault fork-maintenance design

**Date**: 2026-05-20
**Scope**: Bring `zjean/STLVault` up to the same maintenance footing as `zjean/server` (the Sync-in fork) — CLAUDE.md operating notes, three Claude skills, and the GitHub-side infrastructure that makes upstream syncs and upstream contributions safe and routine.

## Fork shape

- **Upstream**: `moddroid94/STLVault` (MIT-licensed, Python/FastAPI backend + React/Vite frontend + SQLite).
- **Fork**: `zjean/STLVault`, currently with no `upstream` remote configured and no Claude infrastructure.
- **Maintenance shape (decided)**: track upstream, customize, and also PR fixes back upstream. This means full upstream-sync infra **and** the `upstream-contrib/` workflow.

## Files to create

```
CLAUDE.md                                                  # short, load-bearing operating notes
docs/plans/2026-05-20-fork-maintenance-design.md           # this design doc (the long version)
.claude/skills/stlvault-fork-maintenance/SKILL.md
.claude/skills/stlvault-tackle-issues/SKILL.md
.claude/skills/stlvault-dev-loop-verify/SKILL.md
.github/workflows/upstream-sync.yml
```

## One-time manual steps

These are not automated by the plan — call them out, run them by hand:

1. Add the `upstream` remote with push disabled:
   ```bash
   git remote add upstream git@github-prive:moddroid94/STLVault.git
   git remote set-url --push upstream DISABLE
   git fetch upstream
   ```
2. Create the `upstream-main` branch from upstream's tip and push it:
   ```bash
   git branch upstream-main upstream/main
   git push origin upstream-main
   ```
3. Set the default repo for `gh`:
   ```bash
   gh repo set-default zjean/STLVault
   ```
4. **Branch protection** (GitHub UI → Settings → Branches):
   - `main`: require PRs, require status checks (when CI is wired up), block direct pushes, require conversation resolution, enable `delete_branch_on_merge`.
   - `upstream-main`: require PRs (this effectively blocks human pushes); force-push allowed (the workflow needs it). The `upstream-sync.yml` workflow writes with `GITHUB_TOKEN` and bypasses the PR requirement via its workflow permission.
5. Enable Squash + Merge-commit on the repo's merge settings; disable Rebase. Last-used strategy is sticky per user — double-check on upstream-sync PRs.

## CLAUDE.md content outline

Adapted from `zjean/server`'s CLAUDE.md, with Sync-in-specific sections dropped and STLVault-specific notes added.

**Include**:

1. **Branch protection** — `main` PR-only, `upstream-main` workflow-only. Practical implications: never `git push origin main`; every change including doc fixes flows feature branch → PR → green CI → merge.
2. **Branch naming + commit conventions** table:

   | Purpose | Branch prefix | Commit prefix |
   |---|---|---|
   | New customization (feature, module, config) | `feat/<topic>` | `feat(<area>): ...` or `custom(<area>): ...` |
   | Bug fix in our code | `fix/<topic>` | `fix(<area>): ...` |
   | Edit to an upstream file | `mod/<topic>` | `mod(<area>): ...` |
   | Docs / plans / CI-only changes | `docs/<topic>` or `chore/<topic>` | `docs(...)` / `chore(...)` |
   | Work intended to be PR'd upstream | `upstream-contrib/<topic>` (rooted at `upstream/main`) | conventional, no `custom-*` paths, no fork-flavored language |

3. **Customization isolation** (the load-bearing rule for this fork):
   - **Additions** live under `custom-*` paths. Backend: `backend/custom_<area>/` (Python module convention uses underscores). Frontend: `frontend/components/custom-<area>/`, `frontend/services/custom-<area>.ts`, `frontend/hooks/use-custom-<area>.ts`. Upstream never touches these → zero merge conflicts on additions.
   - **In-place modifications** to upstream files stay small and atomic, with a `mod(<area>): ...` commit so they're greppable: `git log --grep '^mod('`. These are the surface area that *can* conflict on upstream sync.
   - **Frontend custom assets**: stylesheet overrides go in a single `_custom-overrides.css` (or equivalent for the styling system in use) imported after upstream styles, so token changes don't require touching upstream CSS.

4. **Merge strategy per PR type**:
   - feat / fix / mod / docs / chore → **Squash and merge**.
   - Upstream sync PRs (`upstream-main` → `main`) → **Create a merge commit**, to preserve the merge point and keep upstream history legible on `main`.

5. **Versioning and releases**: `<upstream-base>-custom.<n>` — e.g. if upstream is at `v0.5.2`, our first customized release is `0.5.2-custom.1`, then `0.5.2-custom.2`, reset on upstream bump. `metadata.json` and any `package.json` versions stay aligned. Tag with `v<version>` on `main`.

6. **SSH host alias**: both remotes use `git@github-prive:...`, **not** `git@github.com:...`. Verify with `git remote -v`. `gh` is HTTPS so it works either way, but `git push` will fail with "Permission denied (publickey)" if the alias is wrong.

7. **Upstream remote and license**:
   - Remote `upstream` → `git@github-prive:moddroid94/STLVault.git`, push disabled.
   - License is **MIT** — preserve the `LICENSE.md` file and upstream copyright. No AGPL §13 source-link requirement.
   - Sync is automated via `upstream-sync.yml` (weekly + on-dispatch), force-pushes `upstream/main` → `origin/upstream-main`, opens a PR into `main` when there's new work.

8. **Opening pull requests** — PRs must target `zjean/STLVault`, not `moddroid94/STLVault`. Set `gh repo set-default zjean/STLVault` once, and pass `--repo zjean/STLVault` explicitly on every `gh pr create` invocation as belt-and-suspenders. If a PR opens against upstream by mistake, close it immediately and reopen against the fork. Only `upstream-contrib/` branches ever belong on upstream.

9. **Upstream-as-ground-truth** (analogue of sync-in's "classic-UI-as-ground-truth"): for any file *outside* `custom-*`, the upstream version is the authoritative reference. Before editing in place, read the upstream file to understand the contract you're tweaking. Before changing how `custom-*` code calls a FastAPI endpoint or a frontend service, read the upstream caller for the DTO shape, sentinel values, and side-effect sequencing.

10. **Tooling note: `rtk` wrapper** — same gotchas as sync-in: use `rtk proxy git commit --allow-empty` and `rtk proxy gh ...` when you depend on specific JSON fields.

**Drop** (not relevant to STLVault):
- Classic-UI-as-ground-truth (no v2 layer here yet — replaced by the upstream-as-ground-truth note above).
- NC mobile compat (no Nextcloud emulation in STLVault).
- Drizzle migrations (Python/SQLite — to be documented when we make our first migration; STLVault's current state has no formal migration tool that I've seen).
- AGPL §13 user-visible source-link requirement (MIT licensed).

## GitHub workflow: `.github/workflows/upstream-sync.yml`

Direct port of the sync-in version, swapping the repo paths:

- **Triggers**: `schedule: cron 'weekly'` + `workflow_dispatch`.
- **Permissions**: `contents: write`, `pull-requests: write`.
- **Job**:
  1. Checkout `origin/upstream-main`.
  2. Fetch from `https://github.com/moddroid94/STLVault.git`.
  3. Fast-forward `upstream-main` to `upstream/main`. If no change, exit 0.
  4. Force-push `upstream-main` → `origin/upstream-main`.
  5. If `main` already contains everything in `upstream-main`, exit 0.
  6. Otherwise, open or update a PR `upstream-main` → `main` titled `chore: sync upstream (YYYY-MM-DD)`.

The PR is meant to be **merge-committed**, not squashed. CLAUDE.md emphasizes this.

## Skill 1 — `stlvault-fork-maintenance`

**Purpose**: maintain the fork. Three tasks, only one usually live at a time:

1. **Run the upstream sync**: `gh workflow run upstream-sync.yml --repo zjean/STLVault`, then `gh run watch`. Expect either "no changes" or an auto-opened `chore: sync upstream (YYYY-MM-DD)` PR.
2. **Resolve conflicts** when the auto-PR is CONFLICTING. Because `upstream-main` is workflow-writable only, conflicts must be resolved on a third branch:
   ```bash
   git fetch origin
   git checkout -b chore/sync-upstream-YYYY-MM-DD-resolve origin/main
   git merge origin/upstream-main          # resolve conflicts here
   # ... fix conflicts, run tests ...
   git push -u origin chore/sync-upstream-YYYY-MM-DD-resolve
   gh pr edit <N> --repo zjean/STLVault --head chore/sync-upstream-YYYY-MM-DD-resolve
   ```
3. **Investigate `custom-*` impact**: when upstream changes a FastAPI route signature, a Pydantic schema, a React component contract, or a TypeScript type that `custom-*` code consumes, surface the diff and propose concrete patches. Use `git log upstream-main ^main --no-merges` and `git diff main..upstream-main -- backend/app.py backend/importers/ frontend/types.ts frontend/services/` to scope the surface.

**Repo-specific gotchas to encode in the skill**:
- SSH `github-prive` alias.
- `--repo zjean/STLVault` flag on every `gh pr create`.
- `rtk proxy gh ...` whenever depending on specific JSON fields (and for `git commit --allow-empty` / `--no-edit`).
- Merge-commit (not squash) for upstream-sync PRs.
- The `--repo zjean/STLVault` close-and-reopen recipe if a PR accidentally lands on upstream.

## Skill 2 — `stlvault-tackle-issues`

**Purpose**: convert "I want to work on some issues" into a clean PR (or small set of clean PRs) against `zjean/STLVault`, with conventions baked in. Also covers upstream-eligible work routed via `upstream-contrib/`.

**Steps**:
1. **Survey** open issues from both `zjean/STLVault` and `moddroid94/STLVault` (in case we want to tackle an upstream bug and PR it back).
2. **Group**: default one issue per PR. Combine only when issues touch the same file or are facets of one underlying fix and are individually small. Never combine across `feat`/`fix`/`mod` intent.
3. **Pick branch prefix** from the table in CLAUDE.md. For upstream-eligible work, root the branch at `upstream/main` and use `upstream-contrib/<topic>`.
4. **Read upstream-as-ground-truth** for any file you're editing outside `custom-*`. Understand the contract before you change it.
5. **Open the PR** with `gh pr create --repo zjean/STLVault --base main --head <branch> ...`. For `upstream-contrib/` branches, open against `moddroid94/STLVault:main` with `--repo moddroid94/STLVault`.
6. **Squash and merge** for everything except upstream-sync PRs.

**Conventions encoded**: branch/commit prefix table, conversation-context trust ("user just opened issues #X, #Y" — don't re-fetch), the link-back-to-issue PR body format.

## Skill 3 — `stlvault-dev-loop-verify`

**Purpose**: browser-verify frontend changes via `chrome-devtools` MCP before reporting done. Catches the bug classes that pass `vite build` / `npm run lint` but break in the browser.

**STLVault-specific adaptations**:

- **Dev server**: Vite frontend on `:5173`, FastAPI backend on `:8080` (or `:8998` per docker-compose). Both must be running. If `lsof -nP -iTCP:5173 -sTCP:LISTEN` is empty, ask the user to start it (`docker-compose up` or the equivalent local commands) — don't guess.
- **Loopback hijack**: same workaround as sync-in. VS Code's Code Helper grabs `127.0.0.1:<port>`; use the LAN IP (`ifconfig en0 | grep 'inet '`) instead.
- **Auth**: STLVault is currently single-user with no login flow (see README — "Multi-User with Authentication" is on the roadmap as unchecked). Skip the CSRF dance until that lands.
- **Fixtures**: file uploads go through the `/api/...` endpoints; use `evaluate_script` with `fetch()` and `FormData` to upload a known `.stl` fixture from the browser context.
- **Screenshot path**: `/tmp/...` is MCP-allowed.

**Bug classes to specifically smoke-test**:
- 3D viewer rendering (visual regressions in STL/3MF/STEP preview).
- File-upload flows and drag-and-drop targets.
- Thumbnail generation from the 3D viewer.
- Dark/light theme tokens.
- Filename handling on download (PR #30 / commits `493bf59` and `681c518` are recent examples — UUID-vs-real-filename was the bug; static checks didn't catch it).

## Out of scope (for this design)

- Actually creating the files. This document is the plan; creating the files is a separate step the user will trigger.
- Migrating STLVault's database tooling to something Drizzle-equivalent. We'll document the current state when we first need to touch it.
- v2 / classic-UI parallel implementations. STLVault doesn't have a v2 layer.
- `_custom-overrides.css` setup. Plan calls it out as the recommended pattern; concrete wiring waits until the first style customization.

## Sequence for implementation (when ready)

1. Add `upstream` remote, fetch, create `upstream-main` branch, push.
2. Enable branch protection on `main` and `upstream-main` via GitHub UI.
3. Set `gh repo set-default zjean/STLVault`.
4. Open a `docs/fork-infra-bootstrap` PR with:
   - `CLAUDE.md`
   - `docs/plans/2026-05-20-fork-maintenance-design.md` (this file)
   - `.github/workflows/upstream-sync.yml`
   - `.claude/skills/stlvault-fork-maintenance/SKILL.md`
   - `.claude/skills/stlvault-tackle-issues/SKILL.md`
   - `.claude/skills/stlvault-dev-loop-verify/SKILL.md`
5. Squash-merge. Run the upstream-sync workflow once manually to verify it produces "no changes" (since we're starting from upstream's tip).
6. Done. Next time upstream cuts a release, the weekly cron will open the first real sync PR.
