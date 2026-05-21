# Claude operating notes for this repo

This is a fork of [`moddroid94/STLVault`](https://github.com/moddroid94/STLVault), maintained under `zjean/STLVault`. Full workflow details live in [`docs/plans/2026-05-20-fork-maintenance-design.md`](docs/plans/2026-05-20-fork-maintenance-design.md). This file is the short, load-bearing version.

## Branch protection

`main` and `upstream-main` are both protected:

- **`main`** — direct pushes are blocked. All changes (including docs, CI config, trivial fixes) must go through a pull request. Any required status checks must pass and any PR conversations must be resolved before merge.
- **`upstream-main`** — a pure mirror of `upstream/main`. Only the `upstream-sync.yml` workflow should write to it (force-push allowed; human pushes blocked by PR-equivalent requirement).

### Practical implications

- Never attempt `git push origin main` directly. It will be rejected.
- Every change, even a one-line doc fix, flows: feature branch → push → open PR → wait for CI → merge.
- Feature branches are auto-deleted on merge (`delete_branch_on_merge: true`).

## Branch naming and commit conventions

| Purpose | Branch prefix | Commit prefix |
|---|---|---|
| New customization (feature, module, config) | `feat/<topic>` | `feat(<area>): ...` or `custom(<area>): ...` |
| Bug fix in our code | `fix/<topic>` | `fix(<area>): ...` |
| Edit to an upstream file (theming, behavior tweak) | `mod/<topic>` | `mod(<area>): ...` |
| Docs / plans / CI-only changes | `docs/<topic>` or `chore/<topic>` | `docs(...)` / `chore(...)` |
| Work intended to be PR'd upstream | `upstream-contrib/<topic>` | conventional commits, **no `custom-*` paths, no fork-flavored language** — must cherry-pick cleanly onto upstream |

**Upstream-contrib branches must be rooted at `upstream/main`, not `main`.** Example:

```bash
git fetch upstream
git checkout -b upstream-contrib/fix-foo upstream/main
```

### Customization isolation

- **Additions** live under `custom-*` paths. Backend: `backend/custom_<area>/` (Python module convention uses underscores). Frontend: `frontend/components/custom-<area>/`, `frontend/services/custom-<area>.ts`, `frontend/hooks/use-custom-<area>.ts`. Upstream never touches these — zero merge conflicts on additions.
- **In-place modifications** to upstream files stay small and atomic, with a `mod(<area>): ...` commit message so they're greppable (`git log --grep '^mod('`). These are the only surface area that can conflict on upstream sync.
- **Frontend style overrides** live in a single `frontend/_custom-overrides.css` (or equivalent for the project's styling system) imported after upstream styles, so token tweaks don't require editing upstream CSS.

## Merge strategy per PR type

The repo has Squash and Merge-commit both enabled; Rebase is disabled. Pick per PR:

- **Feature / fix / mod / docs / chore PRs → Squash and merge.** Keeps `main`'s history clean; one commit per logical change.
- **Upstream sync PRs (`upstream-main` → `main`) → Create a merge commit.** Preserves the merge point so upstream history stays legible; full upstream history remains available on the `upstream-main` branch regardless.

GitHub remembers the user's last-used strategy; double-check the dropdown on upstream-sync PRs.

## Versioning and releases

- Version scheme: `<upstream-base>-custom.<n>` — e.g. `0.5.1-custom.1`, `0.5.1-custom.2`, then reset on upstream bump to `0.5.2-custom.1`.
- `metadata.json` and any `package.json` `version` fields stay aligned.
- Releases are cut by tagging `v<version>` on `main`. Existing workflows (`Tag and Release.yml`, `Bump App Version.yml`) drive the build; image tags follow.

## SSH host alias

Both remotes use the `github-prive` SSH host alias, **not** `github.com`. The alias is defined in `~/.ssh/config` and maps to `github.com` with the maintainer's fork-specific key. Always use `git@github-prive:<org>/<repo>.git` in any remote URL you write — never `git@github.com:...`. Symptoms when you get this wrong:

- `gh pr create` works fine (it's HTTPS-based), but `git push` fails with "Permission denied (publickey)".
- Cloning a fresh copy with `git@github.com:...` authenticates with the wrong identity and may push to the wrong account.

Quick self-check: `git remote -v` should show `git@github-prive:...` for `origin` and `upstream`. If not, fix with `git remote set-url`.

## Upstream remote and license

- Remote `upstream` → `git@github-prive:moddroid94/STLVault.git` (push intentionally disabled via `DISABLE` push URL).
- Upstream sync is automated: `upstream-sync.yml` runs weekly + on `workflow_dispatch`, force-pushes `upstream/main` → `origin/upstream-main`, and opens a PR into `main` when there's new upstream work.
- License is **MIT**. Preserve `LICENSE.md` and upstream copyright headers. No AGPL §13 user-visible source-link requirement.

## Opening pull requests

**PRs must always target `zjean/STLVault` (the fork), never `moddroid94/STLVault` (upstream), unless the branch is `upstream-contrib/...`.** The `upstream` remote is fetched for sync only — it must not silently receive PRs from this fork.

`gh pr create` picks the target repo from its "default repo" setting, which — in a clone with an `upstream` remote — can silently resolve to `moddroid94/STLVault`. The belt-and-suspenders fix:

1. **Per clone, set the default once:**
   ```bash
   gh repo set-default zjean/STLVault
   ```
   Verify with `gh repo set-default --view` → should print `zjean/STLVault`.

2. **Every `gh pr create` invocation passes `--repo zjean/STLVault` explicitly**, even when the default is set — the flag costs nothing and is the authoritative override if the default ever drifts:
   ```bash
   gh pr create --repo zjean/STLVault --base main --head <branch> --title "..." --body "..."
   ```

**If a PR accidentally opens against upstream:** close it immediately with `gh pr close <n> --repo moddroid94/STLVault --comment "wrong repo"`, then reopen against the fork with `--repo zjean/STLVault`. Do not leave an open PR against `moddroid94/STLVault` — it looks like a contribution attempt and pollutes their queue.

The only PRs that ever belong on `moddroid94/STLVault` are branches with the `upstream-contrib/` prefix, and those are handled as a separate, deliberate workflow (root the branch at `upstream/main`, no `custom-*` paths, no fork-flavored language).

## Upstream-as-ground-truth: read upstream first before editing in place

The fork extends upstream's Python/FastAPI backend and React/Vite frontend. For any file outside `custom-*`, **upstream is the authoritative reference** — runtime contracts (FastAPI route signatures, Pydantic schema field types, sentinel values, side-effect sequences, React component prop contracts, service-layer call patterns) often aren't expressible in types alone.

**Before writing code in `custom-*` that talks to an upstream module, or before modifying an upstream file in place:**

1. Read the upstream version of the file you're about to touch or call into.
2. Note the contract: URL + method for routes, exact DTO shape, sentinel values (e.g. `id: -1` vs `0` for "new"), order of operations, side effects, error shape.
3. If you're editing in place (`mod(<area>):` commit), keep the patch as small as possible — the diff surface is what conflicts on upstream sync.

**When debugging a custom-* feature that doesn't work:** find the upstream module that does the equivalent thing, compare the calls, diff the network request shape if you have DevTools open.

## Running the app locally

Two ways to run STLVault on the dev machine. Pick by what you're iterating on.

### Hot-reload dev (frontend or backend work)

Two terminals, no Docker:

```bash
# Terminal 1 — backend (FastAPI, uvicorn --reload on :8000)
cd backend && ./run.sh

# Terminal 2 — frontend (Vite dev server with HMR on :5173)
cd frontend && npm install && npm run dev
```

The Vite config (`frontend/vite.config.ts`) baked the literal string `"TERA_API_URL"` into `import.meta.env.VITE_API_URL` so that container builds can sed-replace it at runtime via `frontend/env.sh`. In `npm run dev` that substitution never happens, so the frontend has no idea where the backend is. The escape hatch lives in `frontend/services/api.ts:6` — open the browser DevTools console once and run:

```js
localStorage.setItem("api-port-override", "http://localhost:8000")
location.reload()
```

`api.ts` prefers `api-port-override` over the build-time value, so the dev frontend then talks to the local uvicorn. Setting is per-origin and persists across reloads; clear it with `localStorage.removeItem("api-port-override")`.

Single-user, no auth (see below) — once both servers are up, the app just works.

### Production-style (full stack in containers)

For verifying the actual shipped artifact (no HMR, env-substitution active):

```bash
docker-compose up -d --build
# frontend → http://localhost:${APP_PORT}   (default 8999)
# backend  → http://localhost:${API_PORT}   (default 8998)
```

Ports + bind paths come from `.env` (committed defaults work for local). This path serves the built Vite bundle, not the dev server — so frontend code changes require a rebuild.

### Notes

- Backend hot-reload is automatic (`uvicorn --reload` in `run.sh`); frontend HMR is automatic (Vite).
- SQLite DB and uploads live under `backend/data/` and `backend/uploads/` when run locally; under `${DATA_PATH}` / `${UPLOAD_PATH}` when containerized. Don't commit either.
- The dev-loop-verify skill is the canonical reference for verifying frontend changes in a browser (chrome-devtools MCP, loopback-hijack workaround on macOS).

## Authentication and authorization

STLVault is currently **single-user, no login flow** (multi-user with authentication is on the upstream roadmap as unchecked). Until that lands:

- API calls don't need a CSRF or bearer token.
- The frontend doesn't gate routes on auth state.
- Test fixtures can be created via plain `fetch()` against the FastAPI endpoints.

Revisit these notes when the upstream auth work lands — at that point the dev-loop-verify skill needs an auth dance and `custom-*` code that talks to the backend needs to participate in it.

## Tooling note: `rtk` wrapper

The user runs git/gh via the `rtk` proxy (token savings). A few commands don't pass through cleanly and need `rtk proxy` to bypass:

- `git commit --allow-empty` and uncommon `git` flags — rtk's git wrapper rejects some flags.
- `gh api` and `gh ... --json ...` calls where you depend on a specific field value — rtk may reshape the output to a schema stub; use `rtk proxy gh ...` when the precise response matters.

Normal `git status`, `git diff`, `gh pr create`, `gh run list`, `gh workflow run`, etc. work unmodified.

## Authenticating gh

`gh` reads the `zjean` identity token from the `GH_TOKEN_PRIVE` environment variable, not the default `GH_TOKEN`. For any `gh` invocation that needs auth (everything except local-only commands), prefix with `GH_TOKEN="$GH_TOKEN_PRIVE"`:

```bash
GH_TOKEN="$GH_TOKEN_PRIVE" gh pr create --repo zjean/STLVault ...
```

`gh auth status` without the prefix reports "not logged in" — that's expected. The token-via-env pattern keeps the `zjean` identity scoped to this repo and avoids polluting the global `gh` config.
