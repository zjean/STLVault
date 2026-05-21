# Makerworld liked-import — design

Date: 2026-05-21
Status: design → implementation
Refs: [`docs/plans/2026-05-21-makerworld-importer-design.md`](2026-05-21-makerworld-importer-design.md) (the URL-import design this builds on), upstream issue [zjean/STLVault#15](https://github.com/zjean/STLVault/issues/15)

This is the *liked* half of #15. The *collections* half is deferred to a follow-up issue pending Bambu-Studio-network-panel inspection — see [§Collections (out of scope here)](#collections-out-of-scope-here) for the verb-discovery findings that document where the next investigator should pick up.

## Atoms — what the user actually gets

The fork already supports import-by-URL from Makerworld (merged in PR #14). What this design adds: a **picker** that lists the designs the signed-in user has heart-clicked ("liked") on Makerworld, lets them multi-select, and bulk-imports the chosen designs into a destination folder. Each imported model row carries its Makerworld URL in `sourceUrl` (the field that landed in PR #18), so the *Source* link in `DetailPanel` works without any extra plumbing.

**Boundary**: this design does NOT cover Makerworld collections (user-created groupings of designs). Both halves were called out in #15, but endpoint discovery for the collections list endpoint went 0/26 across three probe rounds. The principled next move is Bambu-Studio reverse engineering, not more dart-throwing. Until that lands, the *liked* feature is independently shippable and useful.

## Endpoint — confirmed, not guessed

```
GET https://api.bambulab.com/v1/design-service/my/design/like?limit=N&offset=M
Authorization: Bearer <access_token>
```

Verified live (probe round 1, May 2026, account with 55 likes):

```json
{
  "hits": [ /* Design objects, see below */ ],
  "total": 55,
  "hiddenCnt": 0
}
```

Each `hits[i]` is a rich Design object. The fields we care about for the picker UI and the subsequent import:

| Field | Type | Used for |
|---|---|---|
| `id` | number | the `design_id` already accepted by `_get_design` / `_get_instances` |
| `modelId` | string (e.g. `US2b397383fb6a91`) | the parent ID our existing import flow wants |
| `title` | string | card title |
| `slug` | string | reconstructing the canonical Makerworld URL |
| `cover` | string (URL) | card thumbnail |
| `designCreator.handle` | string | byline under the title |
| `hasLike` | bool | sanity check — always `true` on this endpoint |
| `isPrintable` | bool | grey-out card + disable selection when `false` |
| `nsfw` | bool | optional client-side filter, default off |

Pagination is offset-based and was verified: `?limit=5&offset=5` returns the next page; `?offset=999999` returns 200 with empty `hits[]` (Bambu does not 4xx on past-end, which keeps client logic simple — *no more pages* is signalled by `hits.length === 0` or by `offset + hits.length >= total`).

Auth re-uses the same `bambu_auth.get_valid_access_token(db_conn)` that powers `importfromId`. No new auth surface. Token expiry surfaces as `BambuAuthExpiredError`, mapped to HTTP 401 with `{error: "bambu_auth_expired"}` exactly like the existing flow — the frontend's existing red banner handles it.

**Rate limits**: not probed live, but `offset=5` and `offset=999999` both returned 200 with no `Retry-After`. The realistic browse pattern (one page per scroll, page size 24) is far below anything Bambu rate-limits.

## Backend

Two thin additions, both under `custom_*` paths. No upstream files touched.

**`backend/custom_importers/makerworld.py`** — new dataclass + method on `MakerworldImporter`:

```python
@dataclass(frozen=True)
class LikedDesign:
    design_id: int          # numeric design id (Design.id) — feeds /design/{id}/instances
    model_id: str           # Design.modelId — parent_id in the import flow
    title: str
    slug: str
    cover_url: str
    creator_handle: str
    is_printable: bool
    nsfw: bool

    @property
    def web_url(self) -> str:
        # Canonical Makerworld URL. Used as `sourceUrl` on the imported
        # model row. Bambu redirects bare /models/<id> → /models/<id>-<slug>
        # so the un-slugged form works too — but emitting the slugged form
        # avoids one redirect when the user later clicks the link.
        slug = self.slug.strip("-") or str(self.design_id)
        return f"https://makerworld.com/en/models/{self.design_id}-{slug}"


class MakerworldImporter:
    # ... existing methods unchanged ...

    def list_liked(
        self, *, limit: int, offset: int, db_conn
    ) -> tuple[List[LikedDesign], int, int]:
        """Returns (designs, total, hidden_count).

        Raises BambuAuthExpiredError / BambuAuthNotConfiguredError, same
        as importfromId.
        """
        token = bambu_auth.get_valid_access_token(db_conn)
        url = (
            f"{BAMBU_API_BASE}/v1/design-service/my/design/like"
            f"?limit={limit}&offset={offset}"
        )
        with requests.Session() as s:
            r = s.get(
                url,
                headers={"Authorization": f"Bearer {token}"},
                timeout=_REQUEST_TIMEOUT,
            )
            if r.status_code == 401:
                raise BambuAuthExpiredError(...)
            r.raise_for_status()
            data = r.json()
        return (
            [_parse_liked(h) for h in data.get("hits", [])],
            int(data.get("total", 0)),
            int(data.get("hiddenCnt", 0)),
        )
```

**`backend/custom_routes/makerworld.py`** — one new GET route on the existing `/api/makerworld` router:

```python
@router.get("/liked")
def list_liked(limit: int = 24, offset: int = 0):
    if limit < 1 or limit > 100:
        raise HTTPException(status_code=400, detail="limit must be 1..100")
    if offset < 0:
        raise HTTPException(status_code=400, detail="offset must be >= 0")
    conn = _get_db()
    try:
        try:
            designs, total, hidden = MakerworldImporter().list_liked(
                limit=limit, offset=offset, db_conn=conn
            )
        except (BambuAuthExpiredError, BambuAuthNotConfiguredError) as e:
            raise HTTPException(status_code=401, detail={"error": "bambu_auth_expired"})
        return {
            "hits": [asdict(d) for d in designs],
            "total": total,
            "hiddenCnt": hidden,
        }
    finally:
        conn.close()
```

No DB schema change. No new tables. Bambu credentials table is already in place from PR #14.

## Frontend

One new modal under `custom-importers/`, one wiring touch in `App.tsx` to surface a "Browse Liked" toolbar button. The actual *import* per picked design re-uses the existing `importModelFromIdByHost` path — see [§Import flow per pick](#import-flow-per-pick) for why we don't need a new import endpoint.

**`frontend/services/custom-importers/makerworld.ts`** — new client method:

```ts
async listLiked(limit = 24, offset = 0): Promise<LikedListResponse> {
  const res = await fetch(
    `${apiBase()}/makerworld/liked?limit=${limit}&offset=${offset}`
  );
  if (res.status === 401) {
    const data = await res.json().catch(() => null);
    if (isAuthExpired(data)) throw new MakerworldAuthExpiredError();
  }
  if (!res.ok) throw new Error(`Makerworld /liked HTTP ${res.status}`);
  return res.json();
}
```

**`frontend/components/custom-importers/MakerworldLikedModal.tsx`** — new component. Standard pattern from the existing dialog set:

- Title: *Browse Makerworld Liked*
- Body: paginated grid of cards. Each card shows cover image, title, creator handle, like count. Click toggles selection (checkmark overlay).
- Pagination: bottom of the grid, *Load more* button that appends the next page to the list. Stop when `offset + loaded >= total` or the page returns empty.
- Footer: *Destination folder* dropdown + *Import N selected* button.
- Auth-expired state: shows the same red banner the URL-import modal uses, with a *Go to Settings* link.

### Import flow per pick

For each design the user picked, we already have `id` (numeric) and `modelId` (string) from the liked-list response. The existing URL-import flow does this:

1. Frontend has a URL.
2. Calls `retrieveModelOptionsByHost(url)` → backend calls `/v1/design-service/design/{id}/instances`, returns instances.
3. User picks instances; frontend calls `importModelFromIdByHost(url, instance.id, instance.name, modelId, previewPath, folderId, typeName)` per pick.

We mirror it exactly, just synthesizing the URL from the liked design instead of parsing it from a paste:

```ts
const sourceUrl = liked.webUrl;  // already computed server-side
const instances = await retrieveModelOptionsByHost(sourceUrl);
for (const inst of instances) {
  await importModelFromIdByHost(
    sourceUrl,           // → sourceUrl on the model row (PR #18)
    inst.id, inst.name, inst.parentId, inst.previewPath, folderId, inst.typeName,
  );
}
```

This means **all instances of every picked design get imported**. Most Makerworld designs have one instance; the rare multi-instance designs become N model rows, same as if the user had pasted the URL and ticked all profiles. The alternative — letting the user disambiguate which profile per design — would be a 2-stage modal flow (pick designs → confirm profiles), which is more UI than the MVP needs. v2 can add it if any user actually has multi-profile designs they only partly want.

**App.tsx wiring** (the only `mod(...)` touch):

- New button: *Browse Liked* in the toolbar, next to *Import URL*. Always visible (matches the existing toolbar pattern); the modal handles the not-signed-in state.
- New state: `showLikedModal: boolean`.
- New handler: `handleLikedImport(selected: LikedDesign[], folderId: string)` — runs the per-pick loop above, updates `uploadQueue` for the progress UI, sets `bambuAuthExpired` on `MakerworldAuthExpiredError`.

## Branch + commit plan

Branch: `feat/makerworld-liked-import`

Three commits, in order:

1. `docs(plans): makerworld liked-import design` — this file.
2. `feat(makerworld): list endpoint for liked designs` — `MakerworldImporter.list_liked()` + dataclass + route.
3. `feat(makerworld): liked-import modal + toolbar entry` — frontend client method, modal component, App.tsx wiring.

Single PR. Squash-merge per CLAUDE.md.

## Test plan

- [ ] `vite build` clean.
- [ ] `python -m ast.parse` clean on the two backend files.
- [ ] Manual: open *Browse Liked*, confirm page 1 loads, *Load more* paginates to the end.
- [ ] Manual: pick 2 designs, *Import*, confirm both land in the chosen folder with `sourceUrl` populated and the *Source* row in `DetailPanel` linking back to Makerworld.
- [ ] Manual: with an expired Bambu Cloud session, confirm the modal shows the expired banner and the link to Settings works.
- [ ] Manual: large account (1k+ likes) — confirm *Load more* doesn't lock up the UI between pages. (We don't have such an account locally; if review hits this risk, fall back to "no client-side filtering yet, just paginate" which is the MVP anyway.)

## Collections (out of scope here)

The collections half of #15 is a separate follow-up. Three probe rounds (26 endpoints) and an OPTIONS verb-discovery pass produced this verb map at `api.bambulab.com`:

| Path | Verb | Purpose |
|---|---|---|
| `/v1/design-service/my/favorites` | `POST` | **Create** a collection (requires `title` field). GET returns 405. |
| `/v1/design-service/my/favorites/list` | `PUT, DELETE` | **Mutate** an existing collection. GET / POST both return 405. |
| `/v1/design-service/my/publisheddesigns` | `GET` | **Your published designs**, filtered by `type ∈ {2D, 3D, ALL, RC}` — content-type filter, not ownership filter. Not the collections endpoint. |

The collection **list-read** endpoint was not found among 26 path guesses. Verb discovery via OPTIONS confirmed that the obvious paths (`/my/favorites`, `/my/favorites/list`) are mutation-only at the architecture level — not just blocked for our token.

Recommended next step for the collections follow-up: open Bambu Studio (desktop), sign in, navigate to *My Favorites* / *My Collections*, watch the DevTools network panel filtered on `api.bambulab.com`, copy the GET that fires. Should take ~5 minutes. The implementation pattern thereafter is the same as the liked-import pattern in this design.
