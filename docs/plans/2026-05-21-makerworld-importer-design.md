# Makerworld importer — design

**Status**: design, pre-implementation.
**Closes**: [#7 — Download from sites](https://github.com/zjean/STLVault/issues/7) (Makerworld portion).
**Companion doc**: [2026-05-20-fork-maintenance-design.md](2026-05-20-fork-maintenance-design.md) — fork conventions referenced throughout.

This doc replaces the earlier conversation-only sketch from 2026-05-20. The URL probe done on 2026-05-21 invalidated the "follow the Printables pattern verbatim" assumption — Makerworld's surface is structurally different, and the auth wall is real. The revised plan below reflects what the probe actually showed.

---

## Phase 1 — Atoms (first-principles)

### Domain

**Model page**
A URL on a model-sharing site that represents one publishable design unit, e.g. `https://makerworld.com/en/models/1000000-foo-bar-slug`. One page bundles many files (geometry, profiles, images, descriptions). The URL is the identity the user pastes in. *Same atom as for Printables.*

**Mesh file**
A raw geometry file — `.stl`, `.3mf`, `.step`, `.obj` — that describes shape only, no slicer settings. *Same atom as for Printables.*

**Print profile (instance, in Bambu/Makerworld terms)**
A `.3mf` file that **already contains print settings** baked in: layer height, infill, supports, filament type, per-printer toolhead configs. Functionally a `.3mf`, but the intent is "drop into Bambu Studio / OrcaSlicer and print". Makerworld's API and UI call these *instances* (one model page may have several — e.g. "0.2mm 2 walls 15% infill" vs "0.16mm 3 walls 25%"). The issue (#7) asks explicitly to "support print profiles too", so the importer must treat instances as a first-class downloadable, not just an afterthought.

**Bambu Cloud token**
The bearer credential that authenticates a user against `api.bambulab.com`. Same identity that signs into Bambu Studio, the Bambu Handy mobile app, and Makerworld. Held in the desktop/mobile clients' local storage or returned from a login call. **Functions like a session cookie**: long-lived but eventually expires, and revoking the user's password revokes the token. *Atom*: a string the importer sends as `Authorization: Bearer <token>` on requests to `api.bambulab.com/v1/iot-service/...` so the server knows which user is asking.

**Cloudflare browser challenge**
A defensive layer in front of `makerworld.com` (the HTML site) that returns HTTP 403 with `cf-mitigated: challenge` unless the requesting client passes an interactive JavaScript challenge. *Atom*: a wall that only a real headless-or-headed browser can climb; plain `requests.Session` cannot. **Critical**: `api.bambulab.com` (a different host) is **not behind this wall**, so calling the JSON API directly is the route in — no scraping needed.

**Presigned S3 URL**
A short-lived (~5 min) HTTPS URL hosted on `s3.<region>.amazonaws.com` whose query string embeds a cryptographic signature. The signature is computed over the exact bytes of the URL; any re-encoding of the query string invalidates it. *Atom*: a single-use download token bound to a specific S3 object and a specific expiry time.

**Importer (server-side class)**
Mirrors the role of `PrintablesImporter`: an object with two responsibilities called from two HTTP routes — *discover options* (list a model's files) and *fetch one file* (download bytes for a chosen file). Wraps a `requests.Session` for connection reuse, not for cookie/auth state — the auth state is the static bearer token, not session-derived.

**Two-step import flow**
Same shape as Printables: paste URL → backend returns options → user picks → backend downloads each pick → each becomes one row in `models`. The UX modal in `App.tsx` is already this shape; the Makerworld importer slots in behind it via host-based routing.

---

### Implementation

**Custom-`*` isolation (fork convention)**
Additions live under `backend/custom_*/` (Python module naming uses underscores) and `frontend/{components,services,hooks}/custom-*` (TS uses kebab-case). In-place edits to upstream files are `mod(...)` commits and the diff surface is the conflict tax on upstream sync. The plan minimises `mod(...)` to two trivial wire-up edits (one each in `backend/app.py` and `frontend/App.tsx`).

**Host-based dispatch**
A function on the frontend that picks which backend endpoint to call based on the hostname in the pasted URL. Atom: `new URL(u).hostname.includes('makerworld') ? makerworldApi.options(u) : api.retrieveModelOptions(u)`.

**Single-user, env-var credential**
STLVault is currently single-user with no login flow (per [CLAUDE.md](../../CLAUDE.md)). The Bambu token therefore lives as an env var on the backend container (`BAMBU_CLOUD_TOKEN`), not in the DB and not per-request. *Atom*: a deployment-time secret, not application state. This decision must be revisited when the upstream multi-user roadmap lands — at that point the token becomes per-user and needs to live in the DB.

---

## Phase 2 — Findings from the URL probe (2026-05-21)

### Probe steps and results

| # | Action | Result | Implication |
|---|---|---|---|
| 1 | `curl -I https://makerworld.com/en/3d-models` with Safari UA | HTTP 403, `cf-mitigated: challenge` | Anonymous HTTP scraping of `makerworld.com` is dead-on-arrival. |
| 2 | `curl https://api.bambulab.com/v1/design-service/design/1000000` | HTTP 200, full JSON model metadata | The JSON API at `api.bambulab.com` is **not** behind Cloudflare; anonymous reads work. |
| 3 | `curl https://api.bambulab.com/v1/design-service/design/1000000/instances` | HTTP 200, `{total: 1, hits: [...]}` | Anonymous read of the print-profile list for a model works. |
| 4 | `curl https://api.bambulab.com/v1/iot-service/api/user/profile/1677966` | HTTP 401 `{"code": 4, "error": "Please login."}` | **The actual file-URL endpoint requires a Bambu Cloud bearer token.** No anonymous workaround exists. |

The probe lands us decisively on **branch C** of the earlier plan (authentication required). The two consolation prizes:

1. **No scraping**. We use a real JSON API at a separate host (`api.bambulab.com`), so the entire `_set_client_data`-style anti-bot handshake that `printables.py` has to do is unnecessary. The importer code is materially simpler than `PrintablesImporter`.
2. **Anonymous metadata**. The user can paste a Makerworld URL and see the list of available files **before** providing a token, which means the "Import Options" modal works end-to-end without auth — auth is only required at the final "download this file" step.

### API contract observed (from probe responses)

**`GET https://api.bambulab.com/v1/design-service/design/{designId}` — anonymous**
Returns model metadata. Fields that matter to the importer:
- `id: int` — same as the path designId.
- `modelId: str` — opaque ID like `"US31b1c4c350fdd1"`; needed downstream (the Bambuddy wiki shows it's passed as `?model_id=` on the profile endpoint).
- `title: str`, `slug: str` — for the row's `name`.
- `coverUrl: str` — for the thumbnail. Hosted on `makerworld.bblmw.com` (CDN, no Cloudflare interactive challenge — fetchable from Python).
- `defaultInstanceId: int` — the default profile, useful as a default selection in the modal.
- `isPrintable: bool` — distinguishes models with printable profiles from raw uploads.

**`GET https://api.bambulab.com/v1/design-service/design/{designId}/instances` — anonymous**
Returns `{total: int, hits: list[Instance]}`. Each `Instance` has:
- `id: int` — the **profileId** to use against the download endpoint.
- `profileId: int` — appears to mirror `id`. *(To verify on implementation: confirm `profileId` is what `/iot-service/api/user/profile/{id}` actually keys on. The Bambuddy wiki uses `profileId` in the path.)*
- `title: str` — e.g. `"0.2mm layer, 2 walls, 15% infill"`.
- `cover: str` — preview thumbnail for this specific profile.
- `creator: {...}` — uploader info.
- `detail: {...}` — extended metadata (extension, prediction time, weight, filaments, `hasZipStl: bool`). On the probed model the `detail` was a zero-initialised stub, suggesting a richer per-instance endpoint exists; the importer can ignore `detail` initially and only fetch `id`, `title`, `cover`.

**`GET https://api.bambulab.com/v1/iot-service/api/user/profile/{profileId}?model_id={modelId}` — Bearer auth required**
Per Bambuddy wiki: returns `{url, name}` where `url` is a presigned S3 link valid ~5 min. *To be implemented and verified end-to-end against a real token.*

**Downloading the S3 URL**
**MUST NOT** follow redirects automatically and **MUST NOT** re-encode the query string — S3 signatures are computed over the exact query bytes. The `requests` library re-encodes by default; we must pass `allow_redirects=False` and pass the URL as a single literal string (no `params=` dict). If a redirect is returned, fail loudly — Bambu does not redirect S3 URLs in normal operation, so a redirect means signature error or service change.

**URL → designId regex**
Makerworld URLs are `https://makerworld.com/en/models/{designId}-{slug}` (note: plural `models`, not `model`). Regex: `r'/models/(\d+)'`. Path may include a locale prefix (`/en/`, `/de/`, `/zh/`); the regex doesn't need to anchor on locale.

### What this changes about the original plan

| Original-plan element | Verdict | New direction |
|---|---|---|
| "Mirror PrintablesImporter, including `_set_client_data` anti-bot handshake" | Drop the handshake | Direct JSON calls; no HTML scraping needed. |
| "Branch A/B/C decision before coding" | Resolved → **branch C** | Auth is required; commit to that path. |
| "GraphQL query analogous to MODELQUERY" | Doesn't apply | Two REST endpoints (`/design/{id}` and `/design/{id}/instances`) instead. |
| "30 min URL probe before code" | **Done** | Findings encoded here. |
| "Optional `kind: 'mesh' \| 'profile'` field" | **Required, not optional** | Every Makerworld file is a print profile (`.3mf` with settings). Distinguish from the Printables mesh case in the response. |
| "Token UI in Settings if auth needed" | Now in-scope | Either env var (recommended) or a single-row settings table; see below. |

---

## Phase 3 — Build plan

### Decision: where does the Bambu token live?

Two options, in order of preference:

1. **`BAMBU_CLOUD_TOKEN` env var on the backend container.** Matches the existing single-user, no-login posture. User sets it in `.env`/compose-file alongside `FILE_STORAGE` and `DB_PATH`. Token rotation = restart container. **Recommended.**
2. **A new `app_settings` SQLite table with a `bambu_token` row, edited via a Settings UI field.** Lower friction for the user (no container restart), but introduces the first piece of "user-managed credential" machinery in the app. Defer until env-var pain is felt.

We will ship #1. The token-acquisition instructions go into a section of the README under the new "Makerworld imports" heading: open `https://bambulab.com` in a browser, log in, open DevTools → Application → Local Storage → copy the `cloud_token` value (or capture from a network request's `Authorization` header). Document that the token expires and how to refresh it.

### File layout

```
backend/
  custom_importers/
    __init__.py                    (new, empty)
    makerworld.py                  (new — MakerworldImporter class)
    _persist.py                    (new — shared "write file + insert DB row" helper)
  custom_routes/
    __init__.py                    (new, empty)
    makerworld.py                  (new — APIRouter with /options and /importid)
  app.py                           (mod: 2-line include_router)

frontend/
  services/
    custom-importers/
      makerworld.ts                (new — typed client for the new routes)
      index.ts                     (new — host-based dispatch helper)
  App.tsx                          (mod: dispatch through host-aware helper, update placeholder)

docs/plans/
  2026-05-21-makerworld-importer-design.md   (this file)

README.md                          (mod: add "Makerworld imports" section + env var)
```

### Build sequence

The order matters: each step is independently verifiable before going on to the next.

1. **Backend skeleton** — create the two empty packages (`custom_importers/`, `custom_routes/`) with `__init__.py`. Commit: `feat(makerworld): scaffold custom importer/router packages`.

2. **`MakerworldImporter.getModelOptions(url)`** — implement the anonymous metadata fetch:
   - regex `r'/models/(\d+)'` → designId
   - `GET /v1/design-service/design/{designId}` → grab `modelId`, `title`, `coverUrl`, `slug`
   - `GET /v1/design-service/design/{designId}/instances` → for each instance, emit a `STLModelCollection`-shaped dict:
     - `parentId`: the `modelId` string (will round-trip to the import call)
     - `id`: the instance's `id` (the profileId)
     - `name`: f`"{title} — {instance.title}.3mf"` (or `instance.title`-only — pick what reads better in the modal; can tweak after UI test)
     - `folder`: `None` (Makerworld has no folder concept like Printables; this is fine, the type allows `string | null`)
     - `previewPath`: instance's `cover` if present, else design `coverUrl`
     - `typeName`: `"3mf"` for now (we treat every Makerworld file as a print profile; extend later if we discover raw-STL paths)
   - **Verify**: hit the new code with the design ID `1000000` used in the probe and confirm a non-empty options list comes back.
   - Commit: `feat(makerworld): list print profiles for a model URL`.

3. **`MakerworldImporter.importfromId(profileId, modelId, previewPath)`** — implement the authenticated download:
   - read `BAMBU_CLOUD_TOKEN` from env at instance time; raise a typed exception if absent (the route translates that to HTTP 503 with a helpful message).
   - `GET /v1/iot-service/api/user/profile/{profileId}?model_id={modelId}` with `Authorization: Bearer {token}` → expect `{url, name}`.
   - `requests.get(url, allow_redirects=False, stream=True)` with the S3 URL **as-is** — no `params=` dict, no re-encoding. Read response.content (or stream to disk in the route).
   - thumbnail: `_make_thumbnail(previewPath)` — same base64 pattern as Printables; the CDN host accepts plain requests.
   - return `(file_response, thumbnail)` matching the Printables interface so the persist helper is uniform.
   - **Verify**: with a real token, end-to-end download produces a valid `.3mf` that opens in OrcaSlicer.
   - Commit: `feat(makerworld): download print profile via authenticated Bambu Cloud call`.

4. **`backend/custom_importers/_persist.py`** — extract a `persist_imported_model(file_bytes, *, name, folder_id, ext, description, thumbnail) -> dict` helper. The current persist block in `app.py:500-528` is verbatim duplicated by the new route; extracting it now keeps both routes thin and gives us one place to fix the filename-vs-UUID lineage (the bug PR #5 fixed for downloads has an analogue here on import). Commit: `feat(makerworld): extract shared persist helper for imported models`.

5. **`backend/custom_routes/makerworld.py`** — APIRouter with two POST endpoints:
   - `POST /api/makerworld/options` — body `{url}` → call `importer.getModelOptions(url)`.
   - `POST /api/makerworld/importid` — body `{id, name, parentId, previewPath, folderId, typeName}` → call `importer.importfromId(...)`, then `persist_imported_model(...)`, then return the model dict.
   - Both routes catch the "token missing" exception and return HTTP 503 with `{"error": "BAMBU_CLOUD_TOKEN not configured"}` so the frontend can render a useful message.
   - Commit: `feat(makerworld): expose /api/makerworld options + import routes`.

6. **`mod(app)` wire-up** — two lines added to `backend/app.py`:
   ```python
   from custom_routes import makerworld as makerworld_routes
   app.include_router(makerworld_routes.router)
   ```
   Place them next to the existing `from importers import printables` import (line 22) and `app = FastAPI(...)` block. Commit: `mod(app): wire makerworld router into FastAPI app`.

7. **Frontend client** — `frontend/services/custom-importers/makerworld.ts` mirrors the two Printables methods in `services/api.ts:168-201`, retargeted at `/api/makerworld/...`. Commit: `feat(makerworld): add frontend client for makerworld routes`.

8. **Host-based dispatch** — `frontend/services/custom-importers/index.ts`:
   ```ts
   import { api } from "../api";
   import * as mw from "./makerworld";

   const isMakerworld = (u: string) => {
     try { return new URL(u).hostname.endsWith("makerworld.com"); }
     catch { return false; }
   };

   export const retrieveModelOptionsByHost = (url: string) =>
     isMakerworld(url) ? mw.retrieveOptions(url) : api.retrieveModelOptions(url);

   export const importModelFromIdByHost = (host: string, ...args: Parameters<typeof api.importModelFromId>) =>
     isMakerworld(host) ? mw.importFromId(...args) : api.importModelFromId(...args);
   ```
   (Exact signature TBD; the principle is one boundary helper, called from `App.tsx`.)
   Commit: `feat(makerworld): add host-based dispatch for url import`.

9. **`mod(app)` frontend** — change `App.tsx`'s URL-import submit handler to call `retrieveModelOptionsByHost(url)`, change the placeholder to `https://www.printables.com/model/... or https://makerworld.com/en/models/...`, change the helper text. ~10 lines of diff. Commit: `mod(app): route url import through host-aware dispatcher`.

10. **README** — add a short section "Importing from Makerworld" with:
    - the `BAMBU_CLOUD_TOKEN` env var name, where to set it in the compose file,
    - how to obtain the token from `bambulab.com` (DevTools steps),
    - expiry caveat,
    - link to this design doc.
    Commit: `docs(readme): document Makerworld import + BAMBU_CLOUD_TOKEN`.

### Branch + PR

- Branch: `feat/custom-makerworld-importer` from `main`.
- PR title: `feat(makerworld): import models from makerworld.com`.
- PR body: link this design doc, link the probe findings, list the manual test plan (URL probe replay + end-to-end download with a real token), call out that the token must be configured by the user.
- Squash-merge per [CLAUDE.md](../../CLAUDE.md) (feature PR).
- `Closes #7.`

### Scope explicitly **not** in this PR

- **Raw STL download path.** Makerworld surfaces `Download STL` in the UI, but we haven't discovered an anonymous endpoint for it (probing for one was correctly declined as scout work). If/when one is found, add it as a follow-up `feat(makerworld): support raw STL download` PR. The `typeName` field is already in the wire shape, so adding `"stl"` later is additive.
- **Other Bambu-family sites** (MakerLab, third-party Bambu communities). Same probe-then-implement loop per site.
- **Token refresh / OAuth.** Out of scope; users rotate manually until upstream multi-user auth lands.
- **Profile metadata enrichment.** `filaments`, `prediction` (print time), `weight`, `compatibleDevices` are all available in the instance `detail` payload and could decorate the modal, but the PR ships the minimal flow first.
- **Caching of model metadata.** Every "list options" call hits Bambu's API. Fine for a single-user app; revisit if rate limits surface.

---

## Phase 4 — Risks and mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Bambu Cloud API changes path or auth scheme | Low-medium (unofficial API) | Importer is isolated under `custom_importers/`; rewrites stay local. Document the probe procedure in this file so the next maintainer can re-do it. |
| `BAMBU_CLOUD_TOKEN` expires silently and import starts 401-ing | High over weeks/months | Route catches 401 and returns `{"error": "BAMBU_CLOUD_TOKEN expired or invalid"}`; frontend renders this in the modal so the user knows to refresh. Log the failure at backend warning level. |
| User pastes a Makerworld URL with no token configured | High on first use | 503 with a clear message; README has the setup steps inline. |
| S3 presigned URL signature breaks due to redirect/encoding | Medium during initial implementation | Pinned in this doc: `allow_redirects=False`, no `params=`. Verify on first end-to-end test. |
| Cloudflare adds `api.bambulab.com` behind a challenge in the future | Low | If/when it does, the same chrome-devtools probe loop applies; the importer would need a browser-shaped client. Out of scope until it happens. |
| Upstream auth model lands and conflicts with single-user env-var approach | Eventual | Documented in [CLAUDE.md](../../CLAUDE.md) — when upstream auth ships, this importer's token becomes per-user. The persist helper and import route are stable; only the `_load_token()` function changes. |

---

## Appendix — probe replay

To re-verify the API surface (useful when Bambu changes anything):

```bash
# 1. Cloudflare wall on the site itself
curl -sI https://makerworld.com/en/3d-models
# expected: HTTP/2 403 + cf-mitigated: challenge

# 2. Anonymous model metadata works
curl -s https://api.bambulab.com/v1/design-service/design/1000000 | head -c 200
# expected: HTTP 200, JSON with id/modelId/title/coverUrl/defaultInstanceId

# 3. Anonymous instance listing works
curl -s https://api.bambulab.com/v1/design-service/design/1000000/instances | head -c 200
# expected: HTTP 200, {"total": 1, "hits": [...]}

# 4. Authenticated download endpoint is gated
curl -s -w '\n%{http_code}\n' https://api.bambulab.com/v1/iot-service/api/user/profile/1677966
# expected: HTTP 401 {"code":4,"error":"Please login."}

# 5. With token (replace XXX):
curl -s -H 'Authorization: Bearer XXX' \
  'https://api.bambulab.com/v1/iot-service/api/user/profile/1677966?model_id=US31b1c4c350fdd1'
# expected: HTTP 200, {"url": "https://s3...", "name": "..."}
```

If any of (2)–(4) changes shape, this design doc is out of date — re-probe before editing the importer.
