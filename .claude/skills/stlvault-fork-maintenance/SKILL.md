---
name: stlvault-fork-maintenance
description: Maintain the zjean/STLVault fork of moddroid94/STLVault — trigger the upstream-sync workflow, resolve the upstream-main→main merge conflicts it produces, and investigate what custom code under `backend/custom_*/` and `frontend/components/custom-*/` needs to adapt when upstream changes backend contracts. Use this skill whenever the user asks to "sync upstream", "pull upstream changes", "merge upstream", "run the upstream workflow", "fix the upstream-sync PR", "resolve upstream conflicts", or "check what upstream changed / what we need to update". Also use when looking at an open chore:sync upstream PR that's CONFLICTING, or when something broke after an upstream sync. Prefer this skill over improvising — the workflow has repo-specific gotchas (SSH host alias, `--repo zjean/STLVault` flag, `GH_TOKEN_PRIVE` env var for auth, `upstream-main` is workflow-writable only, merge commits not squashes) that are easy to get wrong.
---

# STLVault fork maintenance

This skill covers three related tasks on the **zjean/STLVault** fork of **moddroid94/STLVault**:

1. **Run the upstream sync** — trigger the `Upstream Sync` GitHub Actions workflow and monitor what it produces.
2. **Resolve conflicts** when the auto-opened `chore: sync upstream (YYYY-MM-DD)` PR is CONFLICTING — `upstream-main` is a pure mirror, so conflicts must be resolved on a third branch.
3. **Investigate custom-code impact** — determine whether the upstream commits break anything in `backend/custom_*/` or `frontend/components/custom-*/` and propose concrete patches for wire-contract / function-signature mismatches.

Only one of these is usually live at a time. Figure out which the user wants from context, then jump in. If the user just says "sync upstream", start with task 1 and progress through 2 and 3 as the workflow produces a conflict or the diff reveals backend changes.

## Core repo conventions

These override default instincts — read once, apply throughout.

### SSH host alias

Both `origin` and `upstream` remotes use `git@github-prive:...` **not** `git@github.com:...`. The alias is defined in the user's `~/.ssh/config` and maps to `github.com` with the maintainer's fork-specific SSH key.

- `git push` uses SSH → requires the alias.
- `gh` CLI uses HTTPS → works regardless.
- Never write `git@github.com:` anywhere — wrong identity, pushes to wrong account.
- Verify with `git remote -v`; fix drift with `git remote set-url`.

### gh authentication

`gh auth status` reports "not logged in" — that's expected. The `zjean` identity token lives in the **`GH_TOKEN_PRIVE`** environment variable, not the default `GH_TOKEN`. Prefix any auth-requiring `gh` call:

```bash
GH_TOKEN="$GH_TOKEN_PRIVE" gh pr create --repo zjean/STLVault ...
GH_TOKEN="$GH_TOKEN_PRIVE" gh workflow run "Upstream Sync"
GH_TOKEN="$GH_TOKEN_PRIVE" gh run list --workflow "Upstream Sync"
```

Local-only commands (`gh repo set-default --view`) work without the prefix.

### gh CLI gotchas

- **Every `gh pr create` must pass `--repo zjean/STLVault`.** `gh` may inherit its default repo from the `upstream` remote otherwise, which means PRs accidentally target `moddroid94/STLVault`. The flag is authoritative — use it even when default is set. If a PR opens against upstream by mistake, close it with `GH_TOKEN="$GH_TOKEN_PRIVE" gh pr close <n> --repo moddroid94/STLVault --comment "wrong repo"` and reopen with `--repo zjean/STLVault`.
- **`rtk proxy` for any `gh` call where you depend on specific JSON fields.** The `rtk` proxy reshapes / pretty-prints `gh` output for token savings — great in the common case, lossy when a precise field value matters. This applies to *all* JSON-returning `gh` calls, not just `gh api`: in past sessions on the sister sync-in-server fork, `gh pr view --json mergeable,mergeStateStatus,...` hid the `CONFLICTING` state until re-run through `rtk proxy`. Rule of thumb: if you pass `--json` and you're going to branch on a field, use `rtk proxy gh ...`. Side-effect commands (`gh pr create`, `gh workflow run`, `gh run rerun`) and human-readable listings (`gh run list`, `gh pr list` without `--json`) work fine unmodified.
- **`git commit --allow-empty` / `--no-edit`** — rtk's git wrapper rejects these flags. The merge-commit step in task 2 specifically needs `rtk proxy git commit --no-edit` so the default merge message is preserved without rtk dropping the flag.

### Branch protection

- **`main`** — direct pushes are blocked. Everything goes through a PR. Status checks (when present) must pass before merge.
- **`upstream-main`** — a pure mirror of `upstream/main`, writable only by the `upstream-sync.yml` workflow. Human pushes are blocked by PR-equivalent rules. **You cannot resolve conflicts by pushing to `upstream-main`** — see task 2.
- Feature branches auto-delete on merge.

### Merge strategy (per PR type)

- **feat / fix / mod / docs / chore** → **Squash and merge.**
- **Upstream sync PRs (branch → main with upstream lineage)** → **Create a merge commit.** Preserves the merge point so upstream history stays legible on `main`.

GitHub remembers the last-used strategy per user. Double-check the dropdown on upstream-sync PRs — easy to leave on "squash" from the previous PR and lose the merge point.

## Task 1 — Run the upstream sync

The `Upstream Sync` workflow (`.github/workflows/upstream-sync.yml`) runs weekly on cron plus on-demand. What it does:
1. Checks out `upstream-main` on a runner.
2. Fetches `upstream/main` from `moddroid94/STLVault`.
3. Fast-forwards `upstream-main` to match `upstream/main`.
4. Force-pushes `upstream-main` to the fork.
5. If `main` already contains everything in `upstream-main`, exits.
6. Otherwise, opens (or updates) a PR `upstream-main` → `main` titled `chore: sync upstream (YYYY-MM-DD)`.

### Procedure

```bash
# Trigger the workflow
GH_TOKEN="$GH_TOKEN_PRIVE" gh workflow run "Upstream Sync" --repo zjean/STLVault

# Find the run ID, then watch it (typically <30s)
GH_TOKEN="$GH_TOKEN_PRIVE" gh run list --repo zjean/STLVault --workflow "Upstream Sync" --limit 1
GH_TOKEN="$GH_TOKEN_PRIVE" rtk proxy gh run watch <RUN_ID> --repo zjean/STLVault --exit-status
```

Once the workflow finishes, check whether it opened a PR:

```bash
GH_TOKEN="$GH_TOKEN_PRIVE" gh pr list --repo zjean/STLVault --base main --head upstream-main --state open
```

- **No PR** → upstream had nothing new. Report that and stop.
- **PR open, MERGEABLE** → report PR number, URL, diff stat. Merge when ready via "Create a merge commit". Task 3 investigation still applies if backend files changed.
- **PR open, CONFLICTING** → proceed to task 2.

Use `GH_TOKEN="$GH_TOKEN_PRIVE" rtk proxy gh pr view <n> --repo zjean/STLVault --json mergeable,mergeStateStatus,additions,deletions,changedFiles,body` for the merge state. `MERGEABLE` + `BLOCKED` usually means CI is still running, not a conflict.

## Task 2 — Resolve upstream-main → main conflicts

**Why this is annoying:** the workflow-opened PR has `upstream-main` as its head. If you try to resolve conflicts on `upstream-main` itself, the push is rejected (protected branch, workflow-only). Conflicts must be resolved on a third branch.

### Procedure

```bash
# 1) Make sure you have the latest refs.
git fetch origin main upstream-main

# 2) Close the workflow-opened PR — it will be superseded.
GH_TOKEN="$GH_TOKEN_PRIVE" gh pr close <N> --repo zjean/STLVault \
  --comment "Superseded by a new PR with conflict resolution (upstream-main → main required a merge-base branch since upstream-main is workflow-only)."

# 3) Branch off main and merge upstream-main into it with --no-ff.
git checkout -b sync/upstream-$(date +%Y-%m-%d) origin/main
git merge origin/upstream-main --no-ff --no-edit
# Expect: "Automatic merge failed; fix conflicts and then commit the result."
```

### Resolve the conflicts

List conflicted files: `git diff --name-only --diff-filter=U`.

Likely conflict surfaces in STLVault:
- `backend/app.py` — single-file FastAPI app; upstream changes that touch routes you also customized in-place will conflict here.
- `backend/requirements.txt` — version bumps colliding with custom dependencies.
- `frontend/package.json` and `frontend/package-lock.json` — same.
- `frontend/types.ts` and `frontend/services/` — shared TypeScript surface; renames or signature changes land here.
- `frontend/App.tsx` and component files in `frontend/components/` — only if you've modified them in-place (which `custom-*` isolation aims to avoid).

For lockfile conflicts, prefer regenerating after resolving the manifest: resolve `package.json` / `requirements.txt` first, then re-run `npm install` (frontend) or `uv sync` / `pip install -r requirements.txt` (backend) to regenerate the lockfile cleanly.

When resolving, keep both sets of additions wherever possible — a sync should never silently drop a custom feature. If you must drop one, log it in the PR body.

### Verify before committing

Always run what's available in the project:

```bash
# Frontend (Vite/React)
rtk proxy npm --prefix frontend run build
rtk proxy npm --prefix frontend run lint   # if a lint script exists

# Backend (Python/FastAPI)
# Whatever the project uses — check backend/run.sh and backend/requirements.txt.
# Typical: python -m compileall backend/ for a quick syntax check,
# or `uv run pytest` / `pytest` if tests exist.
```

Fix anything new that surfaces, then commit the merge and push.

**Don't `git add -A`.** The user's working tree often has untracked or modified `.claude/` files (e.g. `.claude/scheduled_tasks.lock`, `.claude/settings.local.json`) — tooling state that doesn't belong in the sync commit. After conflict resolution, every fix you applied is already staged from your per-file `git add` during resolution, and cleanly-auto-merged files are staged by `git merge` itself. So the index already contains exactly the merge content — just commit it.

Stage anything extra (e.g. a regenerated lockfile after `npm install`) by name, verify what's staged, then commit:

```bash
git status --short              # confirm only merge-related files are staged
git add <regenerated-files>     # e.g. frontend/package-lock.json, backend/requirements.txt
rtk proxy git commit --no-edit  # default merge message; rtk needs --no-edit proxied
git push -u origin sync/upstream-$(date +%Y-%m-%d)
```

### Open the replacement PR

```bash
GH_TOKEN="$GH_TOKEN_PRIVE" gh pr create --repo zjean/STLVault \
  --base main --head sync/upstream-$(date +%Y-%m-%d) \
  --title "chore: sync upstream ($(date +%Y-%m-%d)) — conflict resolution" \
  --body "$(cat <<EOF
## Summary

Supersedes #<N> (closed — the workflow-opened upstream-main → main PR was CONFLICTING, and upstream-main is workflow-writable only).

This branch merges origin/upstream-main into a short-lived sync/upstream-YYYY-MM-DD off main, with conflicts resolved in:
- <list conflicted files>

### Upstream commits pulled in
<paste \`git log --oneline origin/main..origin/upstream-main\` output>

### Conflicts resolved
<per-file explanation of what got picked and why>

### Impact on our custom code
<output from task 3, or "None" after investigation>

### Merge strategy
Per CLAUDE.md — **Create a merge commit**. Preserves upstream-main lineage; full upstream history stays available on upstream-main regardless.
EOF
)"
```

Tell the user: "PR #<new> is up. Remember — **merge commit**, not squash, when you merge it."

### Aftermath — once the sync PR is merged

When the user reports the PR is merged, do the local cleanup so the next branch doesn't start from stale state:

```bash
git checkout main
git pull --ff-only                            # advance to the merged commit on origin
git branch -D sync/upstream-$(date +%Y-%m-%d) # delete the local sync branch
```

A small wrinkle worth knowing: GitHub's "Create a merge commit" produces a *new* merge commit on the server side, distinct from the one you made locally. So after the pull, `git log -1 main` shows a commit SHA you didn't author. The tree contents match; only the SHA differs. Don't try to align them — just let `git pull --ff-only` advance.

## Task 3 — Investigate custom-code impact

Triggered when upstream's diff touches files that our `custom_*/` or `custom-*/` code might call into, or when the user asks what needs adapting after a sync.

### Phase 1 — Inventory upstream commits

```bash
git log --oneline origin/main..origin/upstream-main
```

For each commit, list touched files:

```bash
for sha in $(git log --format=%H origin/main..origin/upstream-main); do
  echo "=== $sha ==="
  git show --stat $sha | head -30
done
```

Filter to "interesting" commits: anything touching `backend/app.py`, `backend/importers/`, `frontend/services/`, `frontend/types.ts`, `frontend/hooks/`, or shared React components under `frontend/components/` that our `custom-*` code imports.

Skip pure dep bumps (unless they cross major versions) and pure frontend cosmetics in upstream-only paths.

### Phase 2 — For each interesting commit, diff and classify

```bash
git show <sha> -- <changed-file>
```

Classify each change:

| Bucket | Meaning | Custom-code impact |
|---|---|---|
| **Wire contract changed** | HTTP method, URL, request/response JSON shape (fields added/renamed/removed with semantic meaning) | **Almost certainly breaks us.** Grep our callers; patch. |
| **Internal refactor, signature change** | Python function signature, React prop rename, internal helper renamed | **Doesn't affect frontend → backend wire** — but if our `custom-*` code imports the helper directly, patch the import. |
| **Behaviour change** | Same contract, new validation / new error response / new side effect (e.g. "filename now sanitized before storage") | **Probably compatible; verify error handling.** Check we surface the new error paths. |

Behaviour changes often have subtle consequences — read the diff carefully. New error responses mean new HTTP status codes callers might not handle.

### Phase 3 — Grep custom-* for every changed symbol

For each route path, function name, class, type, or component the upstream commit touched:

```bash
rtk proxy grep -rnE "<SymbolOrPath>" \
  /Users/janwiebe/prive/STLVault/backend/custom_* \
  /Users/janwiebe/prive/STLVault/frontend/components/custom-* \
  /Users/janwiebe/prive/STLVault/frontend/services/ \
  /Users/janwiebe/prive/STLVault/frontend/hooks/
```

(The bare `frontend/services/` and `frontend/hooks/` paths catch in-place `mod(...)` edits that touch upstream files. Skip them if you're confident no `mod()` commits exist in the area.)

If no custom code calls the changed symbol, report "No impact" and move on.

### Phase 4 — Propose concrete patches

When a wire contract actually changed, **write out the exact edit** the user needs to apply:

- File path + line number (use `grep -n` output you already captured).
- Before/after snippet showing the change.
- Whether it's a field added (usually safe, defaults propagate), renamed (breaks — update frontend), or removed (breaks — delete references).
- For behaviour changes (new error path), suggest a handler or a user-facing error string.

Present the patches as a punch list the user can accept or reject — don't silently apply them during an upstream-sync investigation.

### Phase 5 — Report

```markdown
## Upstream changes — custom-code impact

### Commits reviewed
- <sha> <short>
- ...

### Wire-contract changes
(none, or per-change bullets with proposed patches)

### Internal refactors (no wire impact)
(terse list)

### Behaviour changes (verify error handling)
(per-change bullets with what to watch for)

### Recommended follow-ups
- [ ] Apply patch to <file>:<line> — <one-liner>
- ...
```

Keep it scannable. If nothing needs adapting, say "No impact" explicitly and stop.

## Quick-reference snippets

### Get the sync-in-progress status

```bash
GH_TOKEN="$GH_TOKEN_PRIVE" gh workflow list --repo zjean/STLVault
GH_TOKEN="$GH_TOKEN_PRIVE" gh run list --repo zjean/STLVault --workflow "Upstream Sync" --limit 5
GH_TOKEN="$GH_TOKEN_PRIVE" gh pr list --repo zjean/STLVault --base main --head upstream-main --state all --limit 3
```

### See what would come in from an upstream sync without triggering it

```bash
git fetch upstream main
git log --oneline origin/main..upstream/main | head -30
git diff --stat origin/main...upstream/main
```

(This uses the `upstream` remote, which is read-only, not `upstream-main` which is the mirror branch on `origin`.)

### Emergency: re-run failed sync workflow

```bash
GH_TOKEN="$GH_TOKEN_PRIVE" gh run list --repo zjean/STLVault --workflow "Upstream Sync" --status failure --limit 3
GH_TOKEN="$GH_TOKEN_PRIVE" gh run rerun <RUN_ID> --repo zjean/STLVault
```
