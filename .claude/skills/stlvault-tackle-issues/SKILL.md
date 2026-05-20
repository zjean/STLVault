---
name: stlvault-tackle-issues
description: Pick up GitHub issues from the zjean/STLVault backlog (or moddroid94/STLVault upstream) and ship them as PRs that follow this fork's conventions (branch prefixes, conventional-commit style, --repo flag, GH_TOKEN_PRIVE env var, SSH alias, upstream-as-ground-truth, custom-* isolation, squash-vs-merge per PR type). Use this skill whenever the user says any of: "work on issues", "tackle the backlog", "pick up issue #N", "what should I work on next", "open a PR for issues N and M", "let's knock out a few issues", "go through the issues", or any time the user wants to make progress against the open issue list. Also use proactively when the user just opened a batch of issues and the next obvious move is to start working them — propose a grouping into PR(s) and confirm before coding. The skill handles the safe parts (branch naming, target repo flag, ground-truth lookups, PR body link conventions) so the user can focus on the substance.
---

# Working open issues into PRs against zjean/STLVault

This fork has a small but specific PR workflow. `main` is protected — direct pushes are blocked, every change goes through a PR, and `gh pr create` can silently target the upstream `moddroid94/STLVault` repo if you forget the `--repo` flag. On top of that, several conventions (branch prefix, commit prefix, merge strategy, ground-truth source for the file area you're touching) are repo-specific and not derivable from looking at one issue in isolation.

This skill is the recipe for turning "I want to work on some issues" into a clean PR (or a small set of clean PRs), with the conventions baked in so they don't get fluffed.

## Step 0 — Authenticate gh

`gh auth status` reports "not logged in" — that's expected. The `zjean` identity token lives in **`GH_TOKEN_PRIVE`**, not the default `GH_TOKEN`. Prefix every auth-requiring `gh` call:

```bash
GH_TOKEN="$GH_TOKEN_PRIVE" gh issue list --repo zjean/STLVault
```

Local-only commands (`gh repo set-default --view`) work without the prefix.

## Step 1 — Survey the open issues

Always confirm before coding. Start by pulling the list and reading what's actually open — counts and labels alone are not enough to make a grouping decision.

```bash
# Fork issues (our own bugs / customization requests)
GH_TOKEN="$GH_TOKEN_PRIVE" gh issue list --repo zjean/STLVault --state open --limit 50

# Upstream issues (potentially upstream-contrib candidates)
GH_TOKEN="$GH_TOKEN_PRIVE" gh issue list --repo moddroid94/STLVault --state open --limit 50

GH_TOKEN="$GH_TOKEN_PRIVE" gh issue view <N> --repo <owner>/STLVault   # for the ones that look workable
```

When the user names specific issues (`"work on #205 and #206"`), skip to Step 2. When they don't, present a short list of 3-5 candidates ordered by what looks like the highest-leverage / lowest-risk combination — anything tagged `bug` that's narrow and self-contained is a good starter. Ask which they want to go after.

If the user has explicitly opened the issues just now and named them in conversation (common pattern: they ran a review, you created issues, they say "let's start"), trust the conversation context — you don't need to re-fetch every one. But still confirm the grouping before coding.

## Step 2 — Decide what goes in one PR vs separate PRs

The default is **one issue per PR.** That's what makes review fast and rollback safe. Combine into a single PR *only* when:

- The issues touch the same file or the same tightly-coupled module **and** the changes are individually small (each <50 lines).
- The issues are different facets of one underlying fix (e.g. "X is wrong in code path A" + "X is wrong in code path B" where both paths share a helper that needs updating once).

Do **not** combine when:

- The issues are in different applications/modules (e.g. one in `backend/`, one in `frontend/components/custom-*/`). Independent review surfaces, independent rollback risk.
- One is a bug fix and the other is a refactor or "while we're here" cleanup. CLAUDE.md is explicit: *don't* add surrounding cleanup to a bugfix.
- The branch prefix would have to differ (e.g. one is `fix/...` and one is `mod/...`). The prefix encodes intent for the changelog.
- One is an upstream-contrib candidate and the other isn't. Upstream-contrib branches are rooted at `upstream/main` and have stricter style rules — they can't share a branch with fork-flavored work.

When in doubt, split. Two clean PRs review faster than one ambiguous one.

Sketch the plan back to the user before coding:

> Proposing two PRs:
> - `fix/download-filename` — closes #30 (frontend download handler).
> - `feat/custom-collections` — adds collections feature scaffolding under `frontend/components/custom-collections/`.
> Anything else can land separately. OK to proceed?

## Step 3 — Branch name and prefix

The branch prefix tells the reader (and the eventual commit log grep) what kind of change this is. Pick from the table — they're enforced by convention, not by hook, so getting them right matters.

| Issue kind | Branch prefix | Commit prefix |
|---|---|---|
| New custom feature / module under `custom-*` | `feat/<topic>` | `feat(<area>): ...` or `custom(<area>): ...` |
| Bug fix in our own code (anywhere) | `fix/<topic>` | `fix(<area>): ...` |
| Edit to an upstream file (theming, behavior tweak) | `mod/<topic>` | `mod(<area>): ...` |
| Docs, plans, or CI-only | `docs/<topic>` or `chore/<topic>` | `docs(...)` / `chore(...)` |
| Intended for upstream contribution | `upstream-contrib/<topic>` rooted at `upstream/main` | conventional, no `custom-*` paths |

`<area>` examples: `viewer`, `download`, `importer`, `tags`, `custom-collections`, `dev-loop`. Pick one that already exists in `git log --oneline -50` if at all possible — drifting area names splits the changelog.

`<topic>` should be short and grep-friendly. `fix/download-filename` beats `fix/issue-30-downloads-use-uuid-instead-of-name`.

```bash
git checkout main && git pull
git checkout -b fix/<topic>
```

For an `upstream-contrib/` branch, root at upstream:

```bash
git fetch upstream
git checkout -b upstream-contrib/<topic> upstream/main
```

## Step 4 — Do the homework before touching code

CLAUDE.md's **upstream-as-ground-truth** rule decides where to look first.

**If the issue touches an upstream file (i.e. anywhere outside `custom_*/` / `custom-*/`):**

- Read the upstream version of the file first to understand the contract. Use the existing local `upstream` remote (read-only) or `git show upstream/main:<path>` for a quick peek.
- Note: API route shapes (FastAPI: path + method + Pydantic response model), DTO field types, sentinel values (e.g. "what does `-1` mean here vs `0`?"), order of operations, side effects, error shape.
- If you're modifying in place (`mod(<area>):` commit), keep the patch as small as possible — the diff surface is what conflicts on upstream sync.

**If the issue is bug-shaped and the symptom doesn't obviously match the code:**

- Diff against upstream: `git diff upstream/main -- <file>` shows the fork's modifications. The bug may be in our delta, not upstream.
- `git log -10 --oneline -- <file>` to see recent intent before editing.

**If the issue is upstream-applicable (the bug also exists upstream):**

- Decide whether to fix it as an `upstream-contrib/` PR (preferred when the fix is general and contributable) or as a fork-local `mod(...)` PR (when it depends on fork-specific context).
- The two paths are not mutually exclusive: ship a fork-local `mod(...)` to unblock the user now, file the upstream-contrib later. Don't gate user-visible fixes on upstream's review queue.

## Step 5 — Implement, minimal and atomic

CLAUDE.md is explicit: *don't add features, refactor, or introduce abstractions beyond what the task requires.* When you're closing an issue, only touch what the issue actually demands. Pre-existing weirdness in nearby code is for a separate PR.

A few specific things to do *correctly* the first time:

- **New additions go under `custom-*` paths** (`backend/custom_<area>/`, `frontend/components/custom-<area>/`, etc.). This is what makes upstream syncs cheap — additions never collide. Putting new code in upstream paths is what creates the recurring merge-conflict tax.
- **Style overrides** go in a single `frontend/_custom-overrides.css` (or the project's equivalent) imported after upstream styles, not by editing upstream CSS.
- **Tests**: if the project has a test setup, add or update the co-located tests for what you changed. Run the affected file/module, not the whole suite, when iterating.

## Step 6 — Commit, push, open the PR

Commits use the conventional prefix from Step 3's table. Push to `origin` (NOT upstream); the SSH alias is `github-prive`, baked into the remote URL.

```bash
git add <files-by-name>      # don't `git add -A`; CLAUDE.md flags this — .claude/ tooling state sneaks in
git commit -m "fix(download): use model filename instead of UUID

Closes #30."
git push -u origin fix/<topic>
```

If pre-commit hooks fail, fix the underlying issue and make a new commit. Don't `--amend` (the failed commit didn't happen so amend would touch the wrong one) and don't use `--no-verify` unless the user explicitly asks.

For the PR — **always pass `--repo zjean/STLVault` explicitly**, even when the default is set. The flag is the authoritative override against the silent-upstream-targeting bug:

```bash
GH_TOKEN="$GH_TOKEN_PRIVE" gh pr create --repo zjean/STLVault --base main --head fix/<topic> \
  --title "fix(download): use model filename instead of UUID" \
  --body "$(cat <<'EOF'
## Summary
- Download endpoint emitted the UUID as the filename, so saved files lost their human-readable names.
- Thread the model's `name` field through `download_url` and set `Content-Disposition: attachment; filename=...` on the response.

## Test plan
- [ ] Manual: download a model, confirm the saved filename matches the model's name.
- [ ] Edge case: model name with spaces / non-ASCII — confirm encoding is right.

Closes #30.
EOF
)"
```

For an `upstream-contrib/` PR, target upstream:

```bash
GH_TOKEN="$GH_TOKEN_PRIVE" gh pr create --repo moddroid94/STLVault --base main --head upstream-contrib/<topic> \
  --title "fix: ..." --body "..."
```

PR title mirrors the commit subject. PR body conventions:

- Lead with **Summary** (1-3 bullets — *why*, not *what*; the diff already shows what).
- Add **Test plan** as a checkbox list.
- End with `Closes #N` for each issue this PR fully resolves. Use `Refs #N` (no auto-close) when partial.
- For upstream-applicable issues you're shipping fork-locally now, link the upstream issue if one exists and note "Upstream-contrib follow-up: …" if relevant.

## Step 7 — Combine-into-one-PR specifics

When Step 2 said "yes, combine":

- **One branch**, prefix chosen by the *dominant* change kind (fix > mod > chore for ordering).
- **One commit per issue**, each with its own conventional subject and `Closes #N` line in the body. Easier to bisect and to extract one back out if review pushes back.
- **PR body** has a Summary bullet per issue and **multiple `Closes` lines**:

  ```
  Closes #30.
  Closes #31.
  ```

  GitHub closes each on merge. Do not write `Closes #30, #31` — only the first is parsed.

If during review one of the combined fixes is contested, the per-issue commit structure makes it cheap to split: `git rebase -i` the offending commit out, push, and the PR shrinks to the rest.

## Step 8 — Merge strategy

Per CLAUDE.md, the repo allows both squash and merge-commit but rebase is disabled. Pick by PR type:

- **Feature / fix / mod / docs / chore PRs → Squash and merge.** One commit per logical change on `main`.
- **Upstream sync PRs (`upstream-main` → `main`) → Create a merge commit.** Preserves the merge point. (Not what this skill produces, but worth knowing — GitHub remembers the last-used strategy, double-check the dropdown on your next non-sync PR.)

Branch is auto-deleted on merge (`delete_branch_on_merge: true`); no cleanup needed.

## Gotchas

- **`gh pr create` and the wrong repo**: the `upstream` remote being present can make `gh` resolve the default repo to `moddroid94/STLVault` in some cases. Always pass `--repo zjean/STLVault` (or `--repo moddroid94/STLVault` for explicit upstream-contrib). If you opened a PR against upstream by mistake, close it with a "wrong repo" comment and reopen on the fork — don't leave it polluting upstream's queue.
- **`git push origin main`**: blocked. Won't accidentally bypass — but mentioning it because attempting it once burns time.
- **`GH_TOKEN_PRIVE` env var**: this is the `zjean` identity. If you accidentally use `GH_TOKEN` (or no env var at all on a machine where it's set), the action runs as the wrong user. `gh api user --jq '.login'` should always show `zjean` before any side-effect command.
- **rtk wrapper gotchas**: `git commit --allow-empty` is rejected by rtk's git wrapper; use `rtk proxy git commit --allow-empty`. `gh api` calls returning JSON may be reshaped into a schema stub; use `rtk proxy gh api …` when you need the raw response. Normal `git`, `gh pr create`, `gh run list`, etc. pass through unmodified.
- **CI**: status checks (when present) must pass before merge, and any PR conversations must be resolved. Don't merge until green.

## When to deviate

- **A single trivial issue** (one-line typo, comment fix): you don't need branch-and-PR drama — but the policy says you still need a PR because `main` is protected. Use `docs/<short-topic>` and ship it; PR will pass review in seconds.
- **Issue requires significant design work, not a code change**: this skill isn't the right fit. Discuss the design with the user first; the resulting PR may not close the issue (just refs it).

## When this skill doesn't apply

- The user wants to *triage* the backlog (close stale, re-label, write up new findings) but not code. This skill is for shipping PRs.
- The user has uncommitted in-progress work on `main` already. Don't blindly `git checkout -b` from a dirty state — surface what's there first and ask.
- The work is an upstream sync (`chore: sync upstream`). That has its own flow — use `stlvault-fork-maintenance` instead.
