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

**Bambu Cloud access token**
The bearer credential that authenticates a user against `api.bambulab.com`. Same identity that signs into Bambu Studio, the Bambu Handy mobile app, and Makerworld. Returned by the login endpoint alongside an `expiresIn` value of roughly **7,776,000 seconds (~90 days)**. *Atom*: a string the importer sends as `Authorization: Bearer <token>` on requests to `api.bambulab.com/v1/iot-service/...` so the server knows which user is asking. Lifetime is measured in months, not minutes — but it does expire, so the system must handle expiry.

**Bambu Cloud refresh token**
A second string returned alongside the access token at login. *In theory*: trade it for a new access+refresh pair by POSTing to `/v1/user-service/user/refreshtoken`, so the access token can be rotated without re-asking the user for credentials. *In practice today*: per `Doridian/OpenBambuAPI` and confirmed by an unmerged feature request on Home Assistant's Bambu integration ([#565](https://github.com/greghesp/ha-bambulab/issues/565), closed not-planned), Bambu's refresh endpoint **returns 401 for everyone** and is "practically unusable". The community workaround is to re-run the full login flow with stored credentials. *Atom*: a string that *should* be a quiet-rotation key but is currently a dead artifact of the login response — we hold it for forward-compat, attempt to use it optimistically, and fall through to full re-login when (not if) it 401s.

**Bambu 2FA email code**
A 6-digit one-time code that Bambu emails to the user as a mandatory second factor on every login attempt. Issued by `POST /v1/user-service/user/sendemailcode` (path TBD on first probe), consumed by `POST /v1/user-service/user/login` alongside the email address. Bambu enforces 2FA for all accounts now, so **every fresh login requires the user to fetch this code from their inbox and type it in** — no service-account or app-password equivalent exists. *Atom*: a short-lived, user-visible challenge that gates token minting. Implication: token rotation cannot be silent; every ~90 days the user does an in-app sign-in dance.

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

**DB-stored credentials, edited from Settings UI**
The Bambu access + refresh tokens, plus their expiry timestamps, live in a fork-only SQLite table (`custom_bambu_credentials`) populated and rotated through the in-app **Settings** page — not via env var, not via static config. *Atom*: application state managed by the user at runtime, not a deployment-time secret. The reason this beats env var: token rotation every ~90 days needs a 2FA email code that only the user has, so the flow has to be in-app anyway; storing the tokens in the DB lets the same UI handle initial sign-in and re-auth. Plaintext storage is intentional — STLVault is a single-user self-hosted app where the user controls the host filesystem; the token has the same trust level as `data.db` itself. (Revisit when upstream multi-user auth lands — at that point this table grows a `user_id` FK.)

**Token-rotation strategy: optimistic refresh, mandatory re-login fallback**
Before each authenticated call to `/iot-service/...`, the backend checks the stored access-token expiry. If the access token is still fresh, use it. If expired (or 401 returned during the call), attempt `POST /v1/user-service/user/refreshtoken` — recognising that this endpoint currently 401s universally per upstream docs. On refresh-failure (or refresh-401), surface a typed `BambuAuthExpiredError` to the route; the route translates it to HTTP 401 with `{"error": "bambu_auth_expired"}`; the frontend shows a banner in the import modal: *"Bambu Cloud sign-in expired — re-sign-in in Settings."* The user goes to Settings, runs the email-code flow, the new tokens land in the credentials table, the next import attempt succeeds. *Atom*: a state machine with three observable states — `signed_out` (no row), `signed_in` (access token not yet expired), `expired` (row exists but access token past `expires_at`). The UI and routes branch on these three states only; refresh-attempt vs full-relogin is an internal implementation detail of the transition from `expired` back to `signed_in`.

---

## Phase 2 — Findings from the URL probe (2026-05-21)

### Probe steps and results

| # | Action | Result | Implication |
|---|---|---|---|
| 1 | `curl -I https://makerworld.com/en/3d-models` with Safari UA | HTTP 403, `cf-mitigated: challenge` | Anonymous HTTP scraping of `makerworld.com` is dead-on-arrival. |
| 2 | `curl https://api.bambulab.com/v1/design-service/design/1000000` | HTTP 200, full JSON model metadata | The JSON API at `api.bambulab.com` is **not** behind Cloudflare; anonymous reads work. |
| 3 | `curl https://api.bambulab.com/v1/design-service/design/1000000/instances` | HTTP 200, `{total: 1, hits: [...]}` | Anonymous read of the print-profile list for a model works. |
| 4 | `curl https://api.bambulab.com/v1/iot-service/api/user/profile/1677966` | HTTP 401 `{"code": 4, "error": "Please login."}` | **The actual file-URL endpoint requires a Bambu Cloud bearer token.** No anonymous workaround exists. |
| 5 | Login endpoint documented at `POST https://api.bambulab.com/v1/user-service/user/login`, body `{account, password, code}` → returns `{accessToken, refreshToken, loginType, expiresIn}` with `expiresIn` ≈ 7,776,000s (~90 days). | Documented in `Doridian/OpenBambuAPI/cloud-http.md`; not probed live (would require a real account). | The access-token lifetime is ~3 months, and **the login flow requires a 2FA email code** which only the user can supply. Token rotation cannot be silent. |
| 6 | Refresh-token endpoint documented at `POST /v1/user-service/user/refreshtoken` body `{refreshToken}` → in theory returns a new pair. | Per `OpenBambuAPI`: *"This endpoint will only return 401 responses now and is practically unusable."* Cross-checked: ha-bambulab feature request [#565](https://github.com/greghesp/ha-bambulab/issues/565) for refresh-token usage was closed not-planned. | **Silent refresh is not currently possible.** We implement the call optimistically (in case Bambu re-enables it someday) but treat the 401 as the expected outcome and fall through to a full in-app re-login. |

The probe lands us decisively on **branch C** of the earlier plan (authentication required) — and tightens it further: the user-experienced cadence is "sign in once via Settings, re-sign-in every ~90 days when the access token expires." The two consolation prizes:

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

**`POST https://api.bambulab.com/v1/user-service/user/login` — credentials required, no bearer**
Body: `{account: "<email>", password: "<password>", code: "<2fa-code>"}` — either `password` or `code` is supplied, not both. Bambu enforces 2FA on every account, so the practical flow is: backend hits a "send code" endpoint (path TBD on first live probe — search results name `/sendsmscode` and `/sendemailcode`; pick whichever fires on a free-tier account), user fetches the 6-digit code from their inbox, types it into Settings, backend POSTs `{account, code}` to `/login`. Response: `{accessToken, refreshToken, loginType, expiresIn}` with `expiresIn` in seconds (~90 days). Both tokens are stored in `custom_bambu_credentials` along with `now_ms() + expiresIn*1000` as `access_expires_at`.

**`POST https://api.bambulab.com/v1/user-service/user/refreshtoken` — known-broken**
Body: `{refreshToken: "..."}`. Documented to return `{accessToken, refreshToken, expiresIn, refreshExpiresIn}` but in practice **returns 401 for everyone today**. Importer attempts it first when the access token is expired, expects the 401, and on 401 raises `BambuAuthExpiredError` to force the user through full re-login. Implementing the call is one short function — if Bambu ever fixes the endpoint, our users get silent refresh "for free" without a code change.

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
| "Token UI in Settings if auth needed" | **Required**, in-scope this PR | Tokens stored in a new `custom_bambu_credentials` SQLite table; managed via a new Bambu Cloud section in Settings; initial sign-in + re-auth share one in-app flow. Env-var approach rejected because 2FA forces user interaction on every login anyway. |
| "Token refresh / OAuth — out of scope" | **In scope**, but with a twist | Optimistic call to `/refreshtoken` (in case Bambu re-enables it) with mandatory fallback to a full in-app re-login on the inevitable 401. Refresh-flow code is small; the bulk of the work is the re-login UX. |

---

## Phase 3 — Build plan

### Decision: where do the Bambu credentials live?

**DB-stored, single-row table, managed from the Settings UI.** No env vars.

Schema (created idempotently on backend startup, mirroring the existing `CREATE TABLE IF NOT EXISTS` style used for `models`):

```sql
CREATE TABLE IF NOT EXISTS custom_bambu_credentials (
  id                  INTEGER PRIMARY KEY CHECK (id = 1),
  account_email       TEXT,           -- displayed in Settings as "Signed in as ..."
  access_token        TEXT NOT NULL,
  refresh_token       TEXT NOT NULL,
  access_expires_at   INTEGER NOT NULL,  -- unix milliseconds
  refresh_expires_at  INTEGER,           -- unix milliseconds, nullable (login response sometimes omits)
  updated_at          INTEGER NOT NULL
);
```

`CHECK (id = 1)` makes the table single-row by construction — `INSERT OR REPLACE INTO custom_bambu_credentials(id, ...) VALUES (1, ...)` is the only write pattern.

**Why DB and not env:**

1. Bambu enforces 2FA email codes on every login, so token rotation **needs an in-app UX anyway** — there's no scenario where the user wants to edit an env var quarterly.
2. The credentials table also stores the *refresh token* and *expiry timestamps*, which would be awkward in a single env var (and outright ugly as three env vars).
3. The "sign out" affordance is then trivially "delete the row" — no container restart, no shell access.

**Plaintext storage rationale:** STLVault is single-user and self-hosted. The SQLite file is on the user's own disk. Encrypting the token at rest would require a key, the key would have to live somewhere (env var → defeats the env-var-rejection above, or derived from a master password the user types each session → way out of scope). The honest decision is "the token has the same trust level as `data.db`; protect the DB file, you've protected the token." Document this in the Settings UI with a one-liner near the token-status display.

**Sign-in flow** (initial use AND every ~90 days when access expires):

1. User opens Settings → Bambu Cloud → clicks "Sign in".
2. Modal asks for email. Frontend POSTs `{account: <email>}` to a new backend route `/api/makerworld/auth/send-code`.
3. Backend hits the Bambu "send code" endpoint (exact path TBD on first live probe — `/sendemailcode` is the likely one). Backend returns 200.
4. User checks email, copies the 6-digit code into the modal, clicks "Verify".
5. Frontend POSTs `{account, code}` to `/api/makerworld/auth/login`.
6. Backend calls Bambu's `/v1/user-service/user/login` with `{account, code}`, gets back the token pair + expiry, writes to `custom_bambu_credentials`, returns `{signedInAs, accessExpiresAt}` to the frontend.
7. Settings page reflects "Signed in as &lt;email&gt;, expires &lt;date&gt;" + a "Sign out" button.

Step 4–6 happen identically when the user is re-authing after an `expired` state — same UI surface, same backend routes. The credentials row gets `INSERT OR REPLACE`'d.

### File layout

```
backend/
  custom_importers/
    __init__.py                    (new, empty)
    makerworld.py                  (new — MakerworldImporter, uses bambu_auth for token)
    _persist.py                    (new — shared "write file + insert DB row" helper)
  custom_auth/
    __init__.py                    (new, empty)
    bambu_credentials.py           (new — CRUD over custom_bambu_credentials table)
    bambu_auth.py                  (new — send_code, login, get_valid_access_token,
                                          try_refresh, BambuAuthExpiredError)
    schema.py                      (new — CREATE TABLE IF NOT EXISTS at startup)
  custom_routes/
    __init__.py                    (new, empty)
    makerworld.py                  (new — APIRouter: /options, /importid)
    bambu_auth.py                  (new — APIRouter: /auth/send-code, /auth/login,
                                          /auth/status, /auth/sign-out)
  app.py                           (mod: 3-line include_router + schema bootstrap)

frontend/
  services/
    custom-importers/
      makerworld.ts                (new — typed client for /api/makerworld routes)
      bambu-auth.ts                (new — typed client for /api/makerworld/auth routes)
      index.ts                     (new — host-based dispatch helper)
  components/
    custom-makerworld/
      BambuCloudSettings.tsx       (new — sign-in form + status + sign-out button)
  Settings.tsx                     (mod: include <BambuCloudSettings/> at bottom)
  App.tsx                          (mod: dispatch through host-aware helper,
                                          show "re-auth required" banner on 401)

docs/plans/
  2026-05-21-makerworld-importer-design.md   (this file)

README.md                          (mod: add "Importing from Makerworld" section
                                          with sign-in walkthrough screenshots)
```

### Build sequence

The order matters: each step is independently verifiable before going on to the next. Steps 1–4 need no Bambu account at all. Steps 5–8 need a working Bambu account to exercise (the user supplies their own email + can fetch the 2FA code). Step 9 needs a real model URL plus a signed-in session.

1. **Backend skeleton** — create the three empty packages (`custom_importers/`, `custom_auth/`, `custom_routes/`) with `__init__.py`. No business logic yet. Commit: `feat(makerworld): scaffold custom importer/auth/router packages`.

2. **Credentials schema + CRUD** — `backend/custom_auth/schema.py` defines `ensure_bambu_credentials_table(conn)` (the `CREATE TABLE IF NOT EXISTS` from the section above). `backend/custom_auth/bambu_credentials.py` exposes typed `read() -> Credentials | None`, `upsert(creds)`, `delete()`. Call `ensure_bambu_credentials_table` from `app.py` startup next to wherever the `models` table is created. **Verify**: write a one-shot Python REPL session that calls `upsert` then `read` and gets the right shape back. Commit: `feat(makerworld): credentials table + CRUD for bambu cloud tokens`.

3. **`MakerworldImporter.getModelOptions(url)` — anonymous half** — same as the previous version of this plan:
   - regex `r'/models/(\d+)'` → designId
   - `GET /v1/design-service/design/{designId}` → grab `modelId`, `title`, `coverUrl`, `slug`
   - `GET /v1/design-service/design/{designId}/instances` → emit one `STLModelCollection`-shaped dict per instance.
   - **Verify** against the probe's reference design ID `1000000` — confirm a non-empty options list comes back.
   - Commit: `feat(makerworld): list print profiles for a model URL`.

4. **`backend/custom_importers/_persist.py`** — extract `persist_imported_model(...)` from the current `app.py:500-528` Printables persist block. Both the Printables route (eventually, via a follow-up cleanup PR) and the new Makerworld route will call this. Commit: `feat(makerworld): extract shared persist helper for imported models`.

5. **`backend/custom_auth/bambu_auth.py` — auth core** — pure-function module, no FastAPI dependency:
   - `send_code(email)` — POST to Bambu's send-code endpoint (verify the exact path on first live probe — likely `/v1/user-service/user/sendemailcode`; if `/sendemailcode` 404s, fall back to `/sendsmscode` per OpenBambuAPI's path list).
   - `login(email, code)` — POST to `/v1/user-service/user/login` with `{account, code}`. Returns parsed `Credentials` dataclass with `access_token`, `refresh_token`, `access_expires_at` (computed as `now_ms() + expiresIn*1000`).
   - `try_refresh(refresh_token) -> Credentials | None` — POST to `/v1/user-service/user/refreshtoken`. Expected to 401 today; return `None` on any non-200 so the caller knows to escalate to re-login. Log the response at DEBUG level so when Bambu *does* re-enable the endpoint, we'll see it in logs.
   - `get_valid_access_token() -> str` — reads the credentials row; if `access_expires_at > now_ms() + 60_000` (1 min slack), returns the access token as-is. Otherwise calls `try_refresh`, on success `upsert`s the new pair and returns the new access token. On `None`, raises `BambuAuthExpiredError`.
   - **Verify**: with a hand-pasted access token written into the DB via the step-2 REPL, `get_valid_access_token()` returns it on the fresh path; with `access_expires_at` set to `0`, it correctly hits the refresh endpoint, observes the 401, and raises `BambuAuthExpiredError`. Both branches covered without needing a real login yet.
   - Commit: `feat(makerworld): bambu auth core — send-code, login, optimistic refresh, expired-error`.

6. **`MakerworldImporter.importfromId(...)` — authenticated half** — now wire the download to `bambu_auth.get_valid_access_token()`:
   - call `get_valid_access_token()`; let `BambuAuthExpiredError` propagate.
   - `GET /v1/iot-service/api/user/profile/{profileId}?model_id={modelId}` with `Authorization: Bearer {token}`. If the response is 401 anyway (token revoked between check and call), also raise `BambuAuthExpiredError`.
   - Fetch the presigned S3 URL with `allow_redirects=False`, no `params=`, no re-encoding (pinned earlier in this doc).
   - Thumbnail via `_make_thumbnail(previewPath)`.
   - **Verify**: do a real Settings sign-in (manually, via step 8) and end-to-end download a `.3mf` that opens in OrcaSlicer.
   - Commit: `feat(makerworld): download print profile via authenticated bambu cloud call`.

7. **`backend/custom_routes/bambu_auth.py` — auth APIRouter**:
   - `POST /api/makerworld/auth/send-code` — body `{email}` → `bambu_auth.send_code(email)`. Returns 200 `{ok: true}` or 400 on Bambu failure (relay the upstream error message — invalid email format etc.).
   - `POST /api/makerworld/auth/login` — body `{email, code}` → `bambu_auth.login(...)` → `bambu_credentials.upsert(...)`. Returns 200 `{signedInAs, accessExpiresAt}`. On Bambu 4xx, return 400 with the upstream error.
   - `GET /api/makerworld/auth/status` — returns `{signedIn: bool, signedInAs: str | null, accessExpiresAt: number | null, expired: bool}`. Used by Settings to render state.
   - `POST /api/makerworld/auth/sign-out` — `bambu_credentials.delete()`. Returns 200.
   - Commit: `feat(makerworld): expose /api/makerworld/auth routes`.

8. **`backend/custom_routes/makerworld.py` — importer APIRouter**:
   - `POST /api/makerworld/options` — body `{url}` → `importer.getModelOptions(url)`. No auth needed.
   - `POST /api/makerworld/importid` — body `{id, name, parentId, previewPath, folderId, typeName}` → `importer.importfromId(...)`, then `persist_imported_model(...)`. Catches `BambuAuthExpiredError` and returns HTTP 401 with `{"error": "bambu_auth_expired"}` so the frontend knows to surface the re-auth banner.
   - Commit: `feat(makerworld): expose /api/makerworld options + import routes`.

9. **`mod(app)` backend wire-up** — three lines added to `backend/app.py`:
   ```python
   from custom_auth.schema import ensure_bambu_credentials_table
   from custom_routes import makerworld as mw_routes, bambu_auth as mw_auth_routes
   # ... after app = FastAPI(...):
   app.include_router(mw_routes.router)
   app.include_router(mw_auth_routes.router)
   # ... at startup hook / next to the existing models-table create:
   ensure_bambu_credentials_table(get_db_conn())
   ```
   Commit: `mod(app): wire makerworld + bambu-auth routers and credentials schema`.

10. **Frontend auth client** — `frontend/services/custom-importers/bambu-auth.ts` exposes `sendCode(email)`, `login(email, code)`, `getStatus()`, `signOut()`. Plain typed `fetch` wrappers. Commit: `feat(makerworld): frontend client for bambu auth routes`.

11. **`<BambuCloudSettings/>` component** — `frontend/components/custom-makerworld/BambuCloudSettings.tsx`:
    - On mount: `getStatus()` → renders one of:
      - **Signed out**: email input + "Send code" button.
      - **Code sent**: 6-digit code input + "Verify" button. Shows the email back to the user. Has a "use a different email" link to reset.
      - **Signed in**: "Signed in as &lt;email&gt; — expires &lt;date&gt;" + "Sign out" button.
      - **Expired**: red banner "Bambu Cloud sign-in expired — sign in again" + the signed-out form.
    - Inline plaintext-storage disclosure: "Tokens are stored in `data.db` on this server. Treat that file as sensitive."
    - Commit: `feat(makerworld): bambu cloud settings component`.

12. **`mod(Settings)` wire-up** — one import + one `<BambuCloudSettings/>` placement at the bottom of `Settings.tsx`'s existing settings sections. Commit: `mod(settings): include bambu cloud sign-in section`.

13. **Frontend importer client** — `frontend/services/custom-importers/makerworld.ts` mirrors the two Printables methods in `services/api.ts:168-201`, retargeted at `/api/makerworld/...`. Commit: `feat(makerworld): frontend client for makerworld routes`.

14. **Host-based dispatch** — `frontend/services/custom-importers/index.ts` per the snippet in this doc's earlier draft, unchanged. Commit: `feat(makerworld): host-based dispatch for url import`.

15. **`mod(App)` frontend** — `App.tsx`:
    - Replace `api.retrieveModelOptions(url)` and `api.importModelFromId(...)` callsites with the host-routing helpers.
    - Update the URL-import placeholder + hint to mention Makerworld.
    - On import-options/import error response of `{error: "bambu_auth_expired"}`, show a banner with a deep-link to Settings (or just clear copy: "Bambu sign-in expired — open Settings to sign in again").
    Commit: `mod(app): host-aware url import + bambu auth-expired banner`.

16. **README** — add **Importing from Makerworld** section: brief on what's supported (print profiles), step-by-step sign-in walkthrough (with screenshot of the Settings section), note about ~90-day expiry, link to this design doc and to upstream OpenBambuAPI docs. Commit: `docs(readme): document Makerworld import + bambu cloud sign-in`.

### Branch + PR

- Branch: `feat/custom-makerworld-importer` from `main`.
- PR title: `feat(makerworld): import models from makerworld.com`.
- PR body: link this design doc, link the probe findings, list the manual test plan (URL probe replay + end-to-end download with a real token), call out that the token must be configured by the user.
- Squash-merge per [CLAUDE.md](../../CLAUDE.md) (feature PR).
- `Closes #7.`

### Scope explicitly **not** in this PR

- **Raw STL download path.** Makerworld surfaces `Download STL` in the UI, but we haven't discovered an anonymous endpoint for it (probing for one was correctly declined as scout work). If/when one is found, add it as a follow-up `feat(makerworld): support raw STL download` PR. The `typeName` field is already in the wire shape, so adding `"stl"` later is additive.
- **Other Bambu-family sites** (MakerLab, third-party Bambu communities). Same probe-then-implement loop per site.
- **Token encryption at rest.** Discussed and explicitly rejected for V1 (single-user self-hosted posture; encrypting would require a key store that defeats the no-env-var decision). Document the plaintext storage in Settings UI; revisit only if a user-supplied master password is ever added.
- **Password-based login (skipping 2FA).** Some Bambu accounts may still allow `{account, password}` login without 2FA, but Bambu has been migrating all accounts to mandatory 2FA. Implementing the email-code flow first covers everyone; supporting the password-only path can be added later if users report a 2FA-disabled account.
- **Profile metadata enrichment.** `filaments`, `prediction` (print time), `weight`, `compatibleDevices` are all available in the instance `detail` payload and could decorate the modal, but the PR ships the minimal flow first.
- **Caching of model metadata.** Every "list options" call hits Bambu's API. Fine for a single-user app; revisit if rate limits surface.
- **Migration to upstream multi-user auth.** When upstream adds login, the `custom_bambu_credentials` table grows a `user_id` FK and the auth routes get gated on the user's own session. Out of scope until that upstream change lands.

---

## Phase 4 — Risks and mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Bambu Cloud API changes path or auth scheme | Low-medium (unofficial API) | Importer + auth-core are isolated under `custom_importers/` and `custom_auth/`; rewrites stay local. Document the probe procedure in this file so the next maintainer can re-do it. |
| Bambu re-enables `/refreshtoken` (good problem) | Unknowable but low-probability | Importer attempts it first regardless; the day it starts returning 200, our users get silent rotation. Logs at DEBUG level on every refresh attempt make the transition observable. |
| Bambu *also* breaks `/login` (catastrophic) | Low | Settings shows a clear error from the upstream response so the user knows it's a Bambu-side problem; the importer continues to handle anonymous metadata so URL-import partially works for the Printables path. No app-level fix possible. |
| Access token expires and user is mid-import | High eventually (every ~90 days) | Both the `/options` and `/importid` routes return `{"error": "bambu_auth_expired"}`; frontend banner deep-links to Settings; user signs in again with email code; previous in-flight import is retried. No data loss because the persist step happens after the authenticated fetch. |
| User signs in but the `expiresIn` value drifts (clock skew, Bambu changing units, etc.) | Low | Clock-skew slack is built in (`expires_at > now + 60s` is the "still valid" check). If the value ever comes back in ms instead of s (or vice versa), our wall-clock check catches it during testing. |
| Account email + tokens stored plaintext in `data.db` | Inherent to design | Documented in Settings UI + this doc + README. Self-hosted single-user posture makes the token's trust level equivalent to `data.db` itself. Encryption-at-rest is in the explicit-out-of-scope list. |
| User pastes a Makerworld URL with no signed-in account | High on first use | Options call succeeds (it's anonymous); import call returns `bambu_auth_expired`; banner sends user to Settings. README's screenshot walks the first-time setup. |
| S3 presigned URL signature breaks due to redirect/encoding | Medium during initial implementation | Pinned in this doc: `allow_redirects=False`, no `params=`. Verify on first end-to-end test. |
| Cloudflare adds `api.bambulab.com` behind a challenge in the future | Low | If/when it does, the same chrome-devtools probe loop applies; the importer would need a browser-shaped client. Out of scope until it happens. |
| Upstream auth model lands and conflicts with our single-user creds table | Eventual | Documented in [CLAUDE.md](../../CLAUDE.md) and the "explicitly not in this PR" section. When upstream auth ships, `custom_bambu_credentials` grows a `user_id` FK and the auth routes gate on the session user. Persist helper, importer, and frontend dispatch are unaffected. |

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

# 6. Login flow (interactive — replace EMAIL and CODE):
#    First request the code; check inbox for 6-digit code:
curl -s -X POST 'https://api.bambulab.com/v1/user-service/user/sendemailcode' \
  -H 'Content-Type: application/json' \
  -d '{"account":"EMAIL"}'
# expected: HTTP 200 — exact response shape TBD on live probe; if 404,
# fall back to /sendsmscode (per OpenBambuAPI endpoint list).

#    Then exchange code for tokens:
curl -s -X POST 'https://api.bambulab.com/v1/user-service/user/login' \
  -H 'Content-Type: application/json' \
  -d '{"account":"EMAIL","code":"CODE"}'
# expected: HTTP 200 {"accessToken":"...","refreshToken":"...","expiresIn":7776000,"loginType":"..."}

# 7. Confirm /refreshtoken is still dead (replace REFRESH):
curl -s -X POST 'https://api.bambulab.com/v1/user-service/user/refreshtoken' \
  -H 'Content-Type: application/json' \
  -d '{"refreshToken":"REFRESH}'
# expected as of 2026-05-21: HTTP 401. If this ever changes to HTTP 200 with a
# fresh pair, congratulations — silent rotation now works for our users.
```

If any of (2)–(4) changes shape, this design doc is out of date — re-probe before editing the importer.
If (6) changes (especially the send-code path), update `bambu_auth.send_code`.
If (7) starts returning 200, no code change is needed — `try_refresh` will succeed and persist the new pair automatically.
