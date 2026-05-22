# Spoolman integration — design

Date: 2026-05-22
Status: design → implementation
Refs: [Spoolman](https://github.com/Donkie/Spoolman), [Spoolman REST API](https://donkie.github.io/Spoolman/)

## Why

STLVault today is a model library — folders, STL/3MF blobs, tags, thumbnails. Nothing about *prints*: no record that a model has been printed, how much filament it ate, which spool it came from, how the print went. The user has an **Elegoo Centauri Carbon** — a closed printer using Elegoo Slicer + Elegoo Cloud, with no Klipper/Moonraker/OctoPrint surface. So the Moonraker-style "printer reports consumption to Spoolman automatically" path is unavailable.

This design adds **STLVault as the bridge**: a lightweight print log per model that also writes spool consumption to Spoolman, so the user gets per-model history *and* accurate remaining filament without double bookkeeping. Spoolman remains authoritative for spool inventory; STLVault becomes authoritative for prints.

## Approach

**One concept added: `print`.** A row that links one STLVault model to one (or more) Spoolman spools, capturing estimated + actual weight, length, time, status, notes. Two user-facing flows, same data model:

1. **Retrospective log** (primary): "I just printed this." One dialog, pre-filled from the sliced file if available, confirm spool, save → Spoolman consume call in the same request.
2. **Start-a-print**: mark "printing now," consume on completion. Useful for ongoing tracking.

Everything is feature-flagged on Settings → Spoolman base URL. Blank = disabled, STLVault behaves exactly as today.

**Integration is REST-only.** Spoolman exposes `GET /spool`, `GET /spool/{id}`, `PUT /spool/{id}/use {use_weight, use_length}`, plus `/filament` and `/vendor` for hydration. STLVault calls those directly with `httpx.AsyncClient`. No SDK, no websocket subscriptions (we don't need live updates — we *produce* the consume events).

**The slicer-file shortcut.** Elegoo Slicer (Orca-derivative) writes weight/length/time estimates into the gcode header and `.3mf` `Metadata/slice_info.config`. STLVault auto-parses whichever sliced file is stored against the model on dialog open, pre-fills the dialog, and lets the user override. This is what makes the retrospective flow one-click in practice.

## Data model

Two new SQLite tables in STLVault, both under `custom_*` so upstream sync never conflicts. Spoolman stays untouched; STLVault stores foreign Spoolman IDs plus a denormalized snapshot for offline display.

```sql
CREATE TABLE custom_prints (
  id              TEXT PRIMARY KEY,            -- uuid
  modelId         TEXT NOT NULL,               -- FK -> models.id (soft, no cascade)
  status          TEXT NOT NULL,               -- 'printing' | 'completed' | 'failed' | 'cancelled'
  startedAt       INTEGER,                     -- ms epoch
  completedAt     INTEGER,                     -- ms epoch
  estDurationMin  INTEGER,                     -- from slicer metadata
  actDurationMin  INTEGER,                     -- user-entered on completion
  printer         TEXT,                        -- defaults to 'Elegoo Centauri Carbon'
  notes           TEXT,
  syncedToSpoolman INTEGER NOT NULL DEFAULT 0, -- 0/1 idempotency guard for /use
  createdAt       INTEGER NOT NULL
);

CREATE TABLE custom_print_filaments (
  id              TEXT PRIMARY KEY,
  printId         TEXT NOT NULL,
  spoolId         INTEGER NOT NULL,            -- Spoolman spool id
  estWeightG      REAL,                        -- slicer estimate, immutable
  usedWeightG     REAL,                        -- what we actually deducted
  estLengthMm     REAL,
  usedLengthMm    REAL,
  spoolLabel      TEXT,                        -- snapshot: "Bambu PLA Matte Charcoal"
  filamentColor   TEXT,                        -- snapshot: hex
  consumedAt      INTEGER                      -- ms epoch when /use succeeded
);
```

**Dual weight columns** are deliberate. `estWeightG` is captured once from the slicer and never mutated. `usedWeightG` defaults to the estimate in the UI but the user can override (scale-weighed remnant, failed mid-print, purge tower waste). Only `usedWeightG` is sent to Spoolman. Keeping both lets us later answer "how much does my slicer over/underestimate by?" — zero UI cost today.

**Multi-spool by design.** The Centauri Carbon is single-extruder, so v1 UI shows one filament row. But Spoolman's data model and real life are multi-spool (color swaps, AMS later). The child table costs nothing today and avoids a migration when an AMS-equivalent shows up.

**Snapshot fields** (`spoolLabel`, `filamentColor`) exist purely so print history stays readable if a spool is later archived or deleted in Spoolman. Live spool data is always re-fetched from Spoolman when the picker opens — the snapshot is for the past, not the present.

**Migration**: forward-only `CREATE TABLE IF NOT EXISTS` in `custom_prints/schema.py` and `custom_spoolman/schema.py`, called from `app.py` next to the existing `ensure_bambu_credentials_table` invocation.

## Sync semantics

The only thorny bit. Spoolman's `PUT /spool/{id}/use` is **not idempotent** — it increments `used_weight` each call. The `syncedToSpoolman` flag is the guard.

1. On completion the backend writes the `custom_prints` row first with `syncedToSpoolman=0`, then attempts `PUT /spool/{id}/use` for each filament row.
2. On success: set `syncedToSpoolman=1`, store `consumedAt`, return 200 with the spool's new `remaining_weight` echoed back for the UI ("Spool now at 743g").
3. On failure (Spoolman down, network, 4xx): print row stays, flag stays 0, frontend shows a non-blocking warning "Logged locally, not yet sent to Spoolman — retry?" with a retry button calling `POST /api/prints/{id}/resync`. No background worker, no queue.
4. Editing a synced print's `usedWeightG` is **not supported in v1** — would require a compensating call to Spoolman that's easy to get wrong if the spool was archived/replaced. Dialog shows weight as read-only for synced prints.
5. Deleting a synced print **does not reverse** the Spoolman consumption. UI confirmation warns the user and links to the spool in Spoolman so they can adjust manually:

> Deleting this print won't reverse the **42g** deducted from spool **#12** in Spoolman. **[Open spool in Spoolman ↗]**

## Backend API

All new routes in `backend/custom_routes/{spoolman,prints}.py`, wired in `app.py` next to the existing `mw_*` registrations. URL prefixes `/api/spoolman` and `/api/prints` make the fork-only surface obvious.

**Spoolman proxy & settings:**

```
GET    /api/spoolman/settings           → { baseUrl, enabled, hasApiKey }
PUT    /api/spoolman/settings           ← { baseUrl, apiKey?, enabled }
POST   /api/spoolman/test               → { ok, version } | { ok:false, error }
GET    /api/spoolman/spools             → [SpoolSummary]   # archived=false
GET    /api/spoolman/spools/{id}        → SpoolDetail
POST   /api/spoolman/parse-slice        ← multipart file=<.gcode|.3mf>
                                        → { estWeightG, estLengthMm, estDurationMin, filamentColorHex? }
```

`SpoolSummary` is `{ id, label, color_hex, material, remaining_weight, vendor_name }` — built server-side so the frontend doesn't depend on Spoolman's wire format. Decouples the UI from a possible future inventory backend swap.

**Prints (STLVault-native):**

```
GET    /api/models/{modelId}/prints     → [Print]
POST   /api/models/{modelId}/prints     ← StartPrintBody | LogCompletedBody
GET    /api/prints                      → [Print]   # global, paginated + filters
GET    /api/prints/{id}                 → Print
PATCH  /api/prints/{id}                 ← { status?, completedAt?, actDurationMin?, notes? }
DELETE /api/prints/{id}                 → { ok }   # local-only, does NOT reverse Spoolman
POST   /api/prints/{id}/complete        ← CompleteBody  # consume happens here
POST   /api/prints/{id}/resync          → { ok, newRemainingG }
```

`StartPrintBody`: `{ status: "printing", filaments: [{ spoolId, estWeightG, estLengthMm? }], estDurationMin?, startedAt? }` — writes row, no consume.

`LogCompletedBody`: `{ status: "completed", filaments: [{ spoolId, estWeightG, usedWeightG, estLengthMm?, usedLengthMm? }], completedAt?, actDurationMin?, notes? }` — writes row and runs consume in the same request.

**Slicer parsing** lives in `backend/custom_spoolman/slicer_parse.py`. Pragmatic: regex over gcode header lines (`; total filament used [g] = X`, `; filament used [mm] = Y`, `; estimated printing time (normal mode) = Hh Mm Ss`), or read `Metadata/slice_info.config` from inside a `.3mf` zip. No slicer SDK. Best-effort — parse failure just leaves fields blank.

The parse endpoint accepts an uploaded file *or* parses the model's stored file when called without a file body (handles both flows from one entry point).

## Frontend UX

Three surfaces, all additive. No upstream component touched.

**Settings → Spoolman section** (`frontend/components/custom-spoolman/SpoolmanSettings.tsx`, mounted in `Settings.tsx` with one `+import` and one element — same one-line touch already used for `CloudSettings.tsx`):

- Base URL input, optional bearer/header field, Enable toggle
- Test connection → green check with version, or red error
- Disabled state hides every print affordance below

**Model DetailPanel → Prints tab** (`ModelPrintsTab.tsx`):

```
┌─ Prints ──────────────────────────────────────┐
│  [+ Log a print]   [▶ Start a print]          │
│                                               │
│  May 21  •  ✓ Completed  •  42g PLA Charcoal │
│           1h 38m  •  Spool #12 → 743g left   │
│           "warped a bit on the corner"  ⋯    │
│                                               │
│  May 18  •  ⚠ Logged, not synced             │
│           38g  •  Spool #12  •  [Retry sync] │
│                                               │
│  May 12  •  ▶ Printing now  •  est 52g       │
│           started 14:02  •  [Complete] [✕]   │
└───────────────────────────────────────────────┘
```

**Log a print dialog** (`LogPrintDialog.tsx`):

```
┌─ Log a print: dragon_v3.stl ─────────────────┐
│  Spool:    [Bambu PLA Matte Charcoal ▼] 851g│
│                                              │
│  Used weight:  [ 42.0 ] g    (est: 41.3 g)  │
│  Used length:  [ 13970 ] mm  (est: 13902)   │
│  Print time:   [ 1h 38m ]    (est: 1h 35m)  │
│                                              │
│  Status: ● Completed  ○ Failed  ○ Cancelled │
│  Notes:  [_____________________________]    │
│                                              │
│  ⓘ Auto-filled from dragon_v3.3mf            │
│  [Upload sliced file]                        │
│                                              │
│             [Cancel]  [Log & deduct spool]  │
└──────────────────────────────────────────────┘
```

On open: parse-slice + spool list fetched in parallel. If the stored file isn't sliced (raw STL), est fields stay blank and the "Upload sliced file" CTA appears; drag/drop a `.gcode`/`.3mf` re-parses. Submit hits `POST /api/models/{id}/prints` with `LogCompletedBody`. Success: "Logged. Spool now at 743g." Failure: "Logged locally. Spoolman didn't accept it — [Retry] [Open spool in Spoolman ↗]."

**Start-a-print** uses the same dialog with the "Used" columns hidden and submit relabeled "Start print" — writes `status=printing`, no consume. The row gets a `[Complete]` button that reopens the dialog pre-populated with est values for confirmation, submitting to `POST /api/prints/{id}/complete`.

**Spool picker** is grouped by material, shows a color swatch from `color_hex`, and the spool's `remaining_weight` on the right. Archived hidden. Subtle "Refresh from Spoolman" icon re-fetches without closing the dialog.

**Delete affordance** on completed-and-synced rows shows the warning + Spoolman link described above.

**Global Prints view** (`PrintsHistoryView.tsx`, new sidebar item below the existing tree):

- Rollup header: this-month grams + hours + count, all-time grams + hours
- Server-side filters: spool, material, folder, date range
- Pagination (≤200 rows default)
- Per-row: model thumbnail, status pill, weight/time, spool swatch
- Click row → open source model in DetailPanel with Prints tab focused

## Local dev environment

Spoolman runs as a peer container, separate from the production `docker-compose.yml`.

**`dev/spoolman/docker-compose.yml`**:

```yaml
services:
  spoolman:
    image: ghcr.io/donkie/spoolman:latest
    container_name: stlvault-dev-spoolman
    ports: ["7912:8000"]
    environment:
      - SPOOLMAN_DB_TYPE=sqlite
      - SPOOLMAN_LOGGING_LEVEL=INFO
      - TZ=Europe/Amsterdam
    volumes:
      - ./data:/home/app/.local/share/spoolman   # gitignored
    restart: unless-stopped
```

**`dev/spoolman/seed.py`** — idempotent stdlib script that POSTs against `http://localhost:7912/api/v1`:

- Vendor: "Bambu Lab"
- Filaments: PLA Matte Charcoal (`#1a1a1a`), PETG-HF Galaxy Black (`#0d0d20`)
- Three spools with realistic `remaining_weight` (near-full, half, near-empty) to exercise picker UX

Re-running is a no-op when records already exist (matched by `(vendor.name, filament.article_number, spool.lot_nr)`).

Three-command bring-up in `dev/spoolman/README.md`:

```bash
docker compose -f dev/spoolman/docker-compose.yml up -d
python dev/spoolman/seed.py
open http://localhost:7912        # sanity check
```

Then in STLVault: Settings → Spoolman, base URL `http://localhost:7912/api/v1`, Test.

Spoolman on `:7912` is a *peer* called from the backend, not proxied through Vite. The dev-loop-verify skill flow becomes: start Spoolman → seed → start backend (`backend/run.sh`) → start frontend (`npm run dev`) → drive browser through Log/Start/Complete/Retry/Delete against real Spoolman → screenshot.

## Phasing

Four PRs, each independently shippable and squash-merged per `CLAUDE.md` conventions. Each PR depends on at most the previous one being on `main`.

**PR 1 — `feat/spoolman-foundation`** — Settings panel, Spoolman client, proxy routes, dev docker + seed. No prints concept yet, but the picker fetches real spools from local Spoolman.

**PR 2 — `feat/spoolman-prints-core`** — prints tables, prints routes (CRUD + complete + resync + parse-slice), ModelPrintsTab in DetailPanel, LogPrintDialog handling both Log and Start variants, delete-with-warning. The whole loop works end-to-end.

**PR 3 — `feat/spoolman-history-view`** — global Prints sidebar entry + filters + rollups.

**PR 4 — `chore/spoolman-polish`** — deferred. Whatever annoys after a week of real use (keyboard shortcuts, bulk-log, CSV export, cost-per-print rollups using Spoolman's `price` field).

## Out of scope, named so it doesn't sneak back in

- Auto-detecting prints from the Carbon (no API to scrape)
- Multi-extruder UI (data model supports it, UI shows one row)
- Editing weight on a synced print with compensating Spoolman calls
- Background retry / queue
- Print scheduling / queue management
- Spool creation/editing inside STLVault (do that in Spoolman; we're a consumer)
