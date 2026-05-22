# Centauri Carbon integration — design

_Plan date: 2026-05-22 (revised after design review)_

STLVault gains a fork-only integration with the Elegoo Centauri Carbon FDM printer. Goal: when a print finishes on the printer, STLVault learns about it automatically, matches it to a model in the library (or offers to create one), and writes a print log entry without the user re-typing time and filament numbers.

The integration is **auto-log with a review queue**: high-confidence matches (multi-signal AND, see below) log silently; everything else lands in an inbox the user clears at their pace.

> **Supersedes:** the Spoolman design (`docs/plans/2026-05-22-spoolman-integration-design.md`) lists "Auto-detecting prints from the Carbon" as out-of-scope. SDCP v3 turned out to be available and documented; this design opens that scope explicitly.

## Scope

**In:**
- Long-running backend listener that speaks SDCP v3 to a Centauri Carbon over the LAN.
- A new `centauri_print_event` table capturing every job the printer finished (success / fail / cancel), independent of whether it was matched to a STLVault model.
- A matcher that proposes STLVault models for each event using source-hash, filename, and recent-slicer-open signals with a confidence score.
- A "Print Inbox" view (`/inbox`) with review actions: confirm, reassign, **create new model from this print's embedded source files**, **reserve placeholder for later upload**, dismiss.
- Auto-confirm only when the multi-signal AND gate fires (see Matching logic). Writes a Spoolman print log directly, surfaces a passive toast and a chip in the existing Recent view. Falls through to inbox whenever any precondition is missing.
- Settings card under Settings → Centauri Carbon: LAN address, mDNS auto-discovery, connection status, "auto-confirm" toggle.

**Out (explicit YAGNI for v1):**
- Multi-printer dashboards. Only `centauri_print_event.printer_id` is keyed; `centauri_settings` is a singleton. See "Schema" for the future-migration note.
- Two-way control ("Send to printer", pause/cancel from STLVault). Different feature, different blast radius.
- Live camera feed / MJPEG embedding. Easy to add later; not the user value here.
- Replacing the Elegoo / OpenCentauri app for routine status. STLVault is a library + print log, not a printer dashboard.

## Why this shape

The printer's view of the world (raw jobs it ran) and STLVault's view (a curated print log linked to models) are different abstractions. Keeping them in separate tables means we can re-run matching later if the library changes, evolve matcher heuristics without rewriting print history, and audit "what the printer actually did" even when no STLVault model exists for a given job.

A review queue beats either extreme:

- **Always require confirmation** is friction the user already pays today (typing time + filament by hand in the Log a print dialog). Auto-confirming high-confidence matches eliminates that friction for the common case.
- **Fully automatic with no review** loses trust on ambiguous matches and provides no path for "this print is for a model I haven't uploaded yet."

## Architecture & data flow

```
┌─ Centauri Carbon ─────────────┐
│  SDCP v3 WS  (port 3030)      │
└──────────────┬────────────────┘
               │  status pushes + on-demand file downloads
               ▼
┌─ FastAPI backend ─────────────┐
│  CentauriClient (asyncio task) │
│   ├─ state-machine: printing→complete/failed/cancelled
│   ├─ on transition: download .gcode.3mf, parse metadata
│   ├─ persist event + run matcher synchronously
│   └─ if auto-confirm gate fires → write custom_prints row
│                                │
│  REST endpoints + SSE under    │
│  /api/centauri/*               │
└──────────────┬────────────────┘
               │
               ▼
┌─ Frontend ────────────────────┐
│  Print Inbox (/inbox)          │
│  ModelPrintsSection chips      │
│  Settings → Centauri card      │
└────────────────────────────────┘
```

Three stages:

1. **Detection.** On a `status: printing → complete|failed|cancelled` transition, the backend pulls the `.gcode.3mf` the job used, parses it (it's a ZIP — extract `Metadata/`, `3D/`, plate-preview PNGs), and writes a `centauri_print_event` row.
2. **Matching.** The matcher runs **synchronously** after each successful event-row insert (so the inbox never shows zero candidates for a fresh event), then again on a 5-minute loop to catch late-arriving recent-slicer-open signals. It writes `centauri_match_candidate` rows (zero or more per event) with confidence + reason.
3. **Review.** The frontend surfaces unreviewed events. User decisions feed back into `centauri_review` and into the existing `custom_prints` table when a print log is created.

## Matching logic

Three signals, each scored independently:

| Signal | Source | Confidence | Notes |
|---|---|---|---|
| **Source-hash match** | MD5 of an embedded mesh in the `.gcode.3mf`, looked up against STLVault model hashes (stored in `custom_centauri/model_hash`, see Schema) | **0.85** | Demoted from 1.0 — see "Why hash alone isn't enough" below |
| **Embedded filename match** | Original `.stl` / `.3mf` filename inside the .3mf metadata, after stripping path + version suffix (regex spec below) | 0.7 single hit / 0.4 multi-hit | First-guess thresholds, recalibrate after 2 weeks of real-printer data |
| **Recent slicer-open** | Model was opened via "Open in slicer" within ~60 min of the print start | 0.3 | Weak suggestion only |

The matcher writes a `match_candidate` row per signal that fires per (event, model) pair. The event's `top_confidence` is the **max** signal score, not an average.

### Auto-confirm gate

Auto-confirm requires **all** of:

- Source-hash match against exactly one STLVault model (`source_hash` signal with exactly one matching `model_id`),
- AND a corroborating signal — either `embedded_filename` matches the same `model_id`, OR `recent_slicer_open` does,
- AND the `.gcode.3mf` has **single plate count** and **all plate-level transforms are identity** (no scale ≠ 1.0, no per-instance rotation/scale variation),
- AND the spool-resolution policy (next section) selects a single spool with `>0g` remaining,
- AND the user's "Auto-confirm" toggle is on (default).

If any precondition fails, the event lands in the inbox. The reviewer's escape valve from C1 — "two signals, no slicer transforms" — is the design choice for v1; the multi-mesh case is explicitly *always* manual until we have a good story for it (see Open questions).

### Why hash alone isn't enough

Three failure modes proved that source-hash equality ≠ "same intent":

1. **Same STL, different scale/orientation.** OrcaSlicer / Elegoo Slicer can preserve the original mesh bytes verbatim while applying scale/rotation/translation at the *plate* level. A 50%-scaled miniature would hash-match the full-size model. Mitigation: the auto-confirm gate above requires plate-transforms = identity.
2. **Multi-plate / multi-object jobs.** A `.gcode.3mf` can contain N embedded meshes (multi-plate or multi-object on one plate). Hashing one mesh is ambiguous about which mesh the print log *means*. Mitigation: auto-confirm requires plate-count = 1 and a single embedded mesh. Multi-mesh events always queue.
3. **Slicer mesh repair changes the bytes.** Slicers can re-tessellate or repair meshes during slicing. First prints from a freshly-uploaded STL may not hash-match. Mitigation: when "Create from this print" runs, we store the *embedded* mesh hash alongside the original-file hash in `custom_centauri/model_hash`, so re-prints of the same slice will match on the embedded-hash row.

### Filename-suffix stripping spec

Applied to the embedded `<original_filename>` from `Metadata/model_settings.config`:

1. Lowercase.
2. Strip extension: `\.(stl|3mf)$`.
3. Strip trailing version markers (longest match wins, applied once):
   - `[-_]v\d+(\.\d+)?` — e.g. `_v1`, `-v2.3`
   - `[-_]\d+$` — bare trailing number (e.g. `_2`)
   - `[-_]?\([^)]*\)$` — trailing paren-blocks (e.g. ` (1)`, `_(scaled)`)
4. Collapse internal whitespace + `_` runs.

Examples (match → STLVault model name lookup uses the same normalisation):

| Embedded filename | Normalised stem |
|---|---|
| `Dragon_v2.stl` | `dragon` |
| `chassis-1.3mf` | `chassis` |
| `gear (3).stl` | `gear` |
| `vase_v1_scaled.stl` | `vase_scaled` (only one suffix stripped — keeps `scaled` as a signal of intent) |

Single-pass strip is a deliberate choice: stripping too aggressively conflates intent-different files.

## Auto-confirm path: spool resolution & Spoolman semantics

This is the central correctness question of the feature.

**Spool selection** when the auto-confirm gate fires:

1. Read filament type + color from the `.gcode.3mf` metadata (`Metadata/slice_info.config`).
2. Query Spoolman for spools where `material == filament_type` AND `color_hex == filament_color_hex` (with a small ΔE tolerance, say `< 5`).
3. If exactly one match with `remaining_weight > 0g` → that's the spool.
4. If zero matches OR multiple matches OR all matches at 0g → **fall through to inbox**, do not auto-confirm. The inbox card surfaces the ambiguity ("matched 2 spools, pick one") and the user resolves it manually.

This means auto-confirm requires unambiguous filament identity at print time. If you swap to a colour you have two spools of, the print queues — that's the right behaviour, not a regression.

**Filament weight resolution:**

- If SDCP reports actual filament consumed (per OpenCentauri docs, the printer exposes this on completion) → use that as `usedWeightG`.
- Otherwise → use `est_filament_g` from `.gcode.3mf` metadata.
- No user moment to override on the auto-confirm path; users who don't trust estimates should leave auto-confirm off.

**Spoolman unreachable:**

- The `custom_prints` row is written with `syncedToSpoolman = 0`.
- The existing Spoolman retry UI (from the Spoolman integration) picks it up. No new retry loop in this feature.
- Auto-confirm itself does *not* gate on Spoolman reachability — better to log locally with the synced flag off than to lose the event.

## Review queue actions

Per event in the inbox:

- **Confirm top candidate** — write a `custom_prints` log entry. Pre-fill from .3mf metadata: estimated time, filament weight, profile name. Spool selection uses the same policy as auto-confirm, but on conflict the user gets a spool-picker UI (no fall-through). User can override any field.
- **Reassign** — pick a different existing model via a search/picker. Same write path as confirm.
- **Create new model from this print** — extract the embedded STL/3MF from the .gcode.3mf, create a new STLVault model row with it as the source file, then attach the print log. Folder defaults to a system "Print Inbox" folder created on first use (see Open questions for the alternative).
- **Reserve for later upload** — see below; the reviewer flagged the original "hash-only match on later upload" design as brittle.
- **Dismiss** — calibration, test print, none-of-the-above. Event row stays in the DB (auditable, can be un-dismissed) but is hidden from the queue.

### Reserve-for-upload, revised

The reviewer (I2) was right that hash-only matching on later upload misses the common case where the user uploads a *different* file for the same intent (vendor-supplied .3mf in slicer → Thingiverse STL uploaded later).

New design:

1. Reserving creates a `centauri_review` row with `action='reserve'` and a `resulting_model_id = NULL`. The event itself stays "reserved" but unlinked.
2. **On any subsequent upload within a 30-day window**, the upload flow checks for outstanding reserved events. If any exist, the upload-confirmation dialog gains a "Link to a recent print?" section listing them with thumbnails. User opts in per-reserved-event.
3. Hash equality between upload and `pendingSource` is a *hint* (auto-tick the checkbox), not a gate.
4. **Day 31:** unmatched reserves auto-flip to `action='dismiss'` with `reason='reserve_expired'`. Audit-trail-preserving.

Two corner cases:

- **One upload matches multiple reserves.** User sees a list, can tick all that apply (multiple print logs from one upload). UI design: checkboxes per reserve, not radio.
- **Duplicate accidental reserve.** User can dismiss a reserve from the inbox at any time; the "Link to upload?" banner respects that.

## UI surface

### Print Inbox (`/inbox`)

A new sidebar entry between Recent and Prints, with a numeric badge for unreviewed events. Visual style consistent with Recent / Tags (full main-area width, same header, `flex-1 overflow-y-auto` body — the `min-h-0` + `shrink-0` pattern we just learned from the detail-panel fix applies if we have a sticky filter bar).

Each event renders as a card showing:

- Thumbnail (extracted from the .3mf's plate preview PNG — OrcaSlicer always bundles one)
- Filename, start/end timestamps, outcome chip (`completed` / `failed` / `cancelled`)
- Time + filament-weight badges (estimate, with "act vs est" delta when the printer reported actuals)
- Match suggestion strip: top candidates' thumbnails, names, confidence dots (green ≥ 0.7, amber 0.3–0.7, red < 0.3). Click to confirm; "More…" opens the reassign picker.
- Action buttons: **Create from this print**, **Reserve for upload**, **Dismiss**.
- For multi-mesh events: explicit "Multi-mesh print — confirm which model the log belongs to" banner.

### Auto-confirmed events

Skip the inbox entirely. Appear in the existing **Recent** view as new print log entries with a small `auto-matched` chip; click the chip to reopen the inbox entry for a 24-hour "undo" window.

### Model detail panel

`ModelPrintsSection` gains:

- A "Printed from Centauri" badge on entries that originated from the printer (vs. manual log).
- A "View source .3mf" link that downloads the archived gcode-3mf from STLVault storage.

### Sidebar

`Inbox` nav item shows a small dot when there are unreviewed events; the count appears on hover and in the header. Muted style when empty.

### Settings

A new "Centauri Carbon" card under Settings (peer to Spoolman):

- Printer LAN address (auto-discovered via mDNS, manual fallback)
- "Test connection" button + current connection status indicator
- "Auto-confirm high-confidence matches" toggle (default on)
- "Backfill MD5 over library" button + progress (one-time on first install)

### Upload page (Reserve-for-upload integration)

When at least one outstanding reserve exists in the last 30 days, the upload-confirmation dialog gains a "Link to a recent print?" section with checkboxes. Auto-tick logic uses pendingSource hash equality.

## Backend internals

### Connection lifecycle

SDCP is WebSocket-based, so the natural model is a persistent connection, not polling. A `CentauriClient` singleton starts in FastAPI's `lifespan`, opens the WS to `ws://<printer-ip>:3030`, subscribes to status updates. Exposed surface:

- `status()` — current job, progress, temps (cached, refreshed on every push)
- `download_job_file(jobId)` — pulls the .gcode.3mf from the printer
- `events()` — async iterator of state transitions for the ingestion loop

### Resilience

- **Printer offline** → reconnect with exponential backoff (1s, 2s, 4s, 8s, capped at 60s). Status surfaced in `/api/centauri/status` so the UI can show "disconnected".
- **STLVault backend restart** → on startup, fetch printer's recent job history via SDCP and reconcile against events we already have. Use `INSERT INTO centauri_print_event ... ON CONFLICT (printer_id, sdcp_job_id) DO NOTHING RETURNING id` — only when a row was actually inserted do we run side effects (download .3mf, run matcher, write archives). The unique index dedups; the RETURNING guards the side effects.
- **Mid-print restart.** A job in state `printing` at restart has no event row yet (we write only on `printing → complete|failed|cancelled`). On reconnect, the WS subscribes to live status pushes. If the very next push is the `complete` push, we already have `started_at` and the `gcode_filename` in the push payload (per SDCP spec — the `printing` payload includes both, persisted in-memory by `CentauriClient` across the gap). Edge case: backend restart + printer firmware reboot before completion → we lose the `started_at`. Acceptable; the event is reconstructed from the printer's history fetch with `started_at` derived from job-list metadata.
- **Two completions between matcher runs.** Matcher runs *synchronously* after each event-row insert (see Architecture). The 5-min loop only re-runs `recent_slicer_open` for already-existing events (catches "user opened in slicer just after print finished" race). It does not re-write hash or filename candidates — those are stable.
- **History fetch + WS push race.** The reconciliation pass on reconnect can see a job in both the history fetch and the next WS push. The unique index + ON-CONFLICT-RETURNING handles it idempotently.
- **WS connection failure must not fail the rest of the backend.** The Centauri client is isolated; STLVault works without it.

### Schema

#### New tables (under `custom_centauri/`)

```sql
CREATE TABLE centauri_print_event (
  id INTEGER PRIMARY KEY,
  printer_id TEXT NOT NULL,
  sdcp_job_id TEXT NOT NULL,
  gcode_filename TEXT NOT NULL,
  started_at TIMESTAMP NOT NULL,
  ended_at TIMESTAMP,
  outcome TEXT NOT NULL CHECK (outcome IN ('completed','failed','cancelled')),
  est_time_min INTEGER,
  act_time_min INTEGER,
  est_filament_g REAL,
  act_filament_g REAL,           -- nullable; populated when SDCP reports actual
  plate_count INTEGER NOT NULL,
  embedded_mesh_count INTEGER NOT NULL,
  plate_transforms_identity INTEGER NOT NULL,  -- 1 if all scale=1.0 + rot=identity
  thumbnail_path TEXT,
  archived_3mf_path TEXT,
  raw_payload TEXT,              -- raw SDCP job JSON
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (printer_id, sdcp_job_id)
);

CREATE TABLE centauri_match_candidate (
  id INTEGER PRIMARY KEY,
  event_id INTEGER NOT NULL,     -- soft FK to centauri_print_event.id (SQLite FKs off)
  model_id TEXT NOT NULL,        -- soft FK to models.id
  signal TEXT NOT NULL,          -- 'source_hash' | 'embedded_filename' | 'recent_slicer_open'
  confidence REAL NOT NULL,
  reason TEXT
);

CREATE TABLE centauri_review (
  event_id INTEGER PRIMARY KEY,  -- soft FK to centauri_print_event.id
  reviewed_at TIMESTAMP NOT NULL,
  action TEXT NOT NULL,          -- 'confirm' | 'reassign' | 'create' | 'reserve' | 'dismiss' | 'auto'
  reason TEXT,                   -- e.g. 'reserve_expired' for auto-flipped dismisses
  resulting_print_id INTEGER,    -- soft FK to custom_prints.id when action created a print log
  resulting_model_id TEXT        -- soft FK to models.id when action created/reserved a model
);

CREATE TABLE centauri_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),  -- singleton; multi-printer becomes centauri_printer table later
  printer_ip TEXT,
  printer_name TEXT,
  printer_uuid TEXT,             -- from SDCP, stable across reboots
  auto_confirm_enabled INTEGER NOT NULL DEFAULT 1,
  last_connected_at TIMESTAMP
);

-- Model-hash side table — does NOT modify upstream models table.
-- Maintained by Centauri integration (backfill + per-upload hash computation
-- when the integration is enabled). Keying by model_id keeps upstream-sync clean.
CREATE TABLE centauri_model_hash (
  model_id TEXT PRIMARY KEY,     -- soft FK to models.id
  source_md5 TEXT NOT NULL,      -- MD5 of the model's source file
  embedded_md5 TEXT,             -- nullable; populated by 'Create from this print'
  computed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

**Why a side table for hashes**: the alternative is adding `md5 TEXT` to the upstream `models` table — a `mod(model):` commit per CLAUDE.md, conflict-prone on upstream sync. Side table is custom-only and free.

All FKs are soft (CHECK / no REFERENCES) matching the existing fork convention in `custom_prints/schema.py` (see header: *"Foreign-key relationships are intentionally soft"*).

#### Changes to existing `custom_prints` table

Lives in `backend/custom_prints/schema.py`, **not** in the Centauri module. The Centauri integration calls into the prints module's migration:

```python
# In custom_prints/schema.py, alongside the existing actDurationMin→wallClockMin migration:

def _ensure_centauri_columns(conn):
    cols = {row[1] for row in conn.execute("PRAGMA table_info(custom_prints)")}
    if "source" not in cols:
        conn.execute(
            "ALTER TABLE custom_prints ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'"
        )
    if "centauri_event_id" not in cols:
        # Soft FK to centauri_print_event.id; nullable.
        conn.execute("ALTER TABLE custom_prints ADD COLUMN centauri_event_id INTEGER")
```

Idempotent. Runs at startup. Mirrors the existing pattern.

### Storage

Archived `.gcode.3mf` files live under `${UPLOAD_PATH}/centauri/<printer_id>/<event_id>.gcode.3mf`. Bounded retention: **keep at most the last 50 per printer AND prune anything older than 30 days** (intersection — the smaller of the two windows wins). A nightly cleanup task prunes.

At 5–50 MB per archive, the upper bound is ~2.5 GB per printer in the worst case. Worth surfacing as a Settings tunable in a later phase; v1 keeps it hard-coded.

Thumbnails (plate previews extracted from each .3mf) live under `${UPLOAD_PATH}/centauri/<printer_id>/thumbs/<event_id>.png`. Same retention as the parent .3mf.

### REST + SSE endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/centauri/status` | Connection state, current job, last seen |
| GET | `/api/centauri/events` | Paginated list, filterable by `reviewed=true/false` |
| GET | `/api/centauri/events/{id}` | Single event detail, including match candidates |
| GET | `/api/centauri/events/stream` | **SSE** — pushes "new event" + "review state change" + "connection state change" for inbox-badge live updates |
| POST | `/api/centauri/events/{id}/review` | Body: `{action, model_id?}`. Idempotent on `(event_id, action)` |
| GET | `/api/centauri/settings` | Returns `centauri_settings` row |
| PUT | `/api/centauri/settings` | Upsert |
| POST | `/api/centauri/test-connection` | Body: `{ip}`. Returns `{ok, printer_uuid?, version?, error?}` |
| POST | `/api/centauri/backfill-hashes` | Kick off MD5 backfill (long-running, progress via SSE) |

## Onboarding flow

First-run under Settings → Centauri Carbon (in Phase 1):

1. Auto-discover printers on the LAN via SDCP's mDNS broadcast (`_sdcp._tcp.local`). Show found printers as cards; click to add. **Manual IP + port entry is the always-works fallback** (mDNS is fragile across VLANs / WiFi isolation).
2. Test connection (single WS handshake + ping). On success, persist `{printer_id, name, ip, model}` to `centauri_settings`.
3. Kick off a one-time MD5 sweep over existing stored model files, writing to `centauri_model_hash`. Progress bar in Settings, non-blocking. The matcher can run before backfill completes — pre-backfill matches will simply miss the source-hash signal until the row arrives.
4. Optional: pull the last 50 print jobs from the printer's history and create events for them. User can review or bulk-dismiss.

## Risks & trade-offs

- **SDCP API churn.** The protocol is community-documented at [docs.opencentauri.cc](https://docs.opencentauri.cc/software/api/) but Elegoo can change it on a firmware release. Mitigation: integration tests against fixtures captured from a real printer, and a defensive parser (unknown fields ignored, not crashed).
- **Library choice — vendored, not depended.** [pycentauri](https://github.com/bjan/pycentauri) is convenient but adds a runtime dep on a single maintainer's repo with no release cadence. Decision: vendor it. To make this safe:
  - Record the upstream commit SHA in `custom_centauri/sdcp.py` header: `# Vendored from pycentauri @ <SHA> on 2026-05-22`.
  - License check **before** the PR. STLVault is MIT (per CLAUDE.md). pycentauri must be MIT/BSD/Apache-compatible. **If it is GPL, do not vendor — write our own from the OpenCentauri docs.**
  - 30-minute spike **before Phase 1 lands**: produce a minimal proof-of-concept that connects to a real Centauri Carbon and reads the status stream. Validates the "~300 lines" estimate; if the real number is 1500, re-evaluate the trade.
- **Matcher first-guess thresholds.** The 0.85 / 0.7 / 0.4 / 0.3 numbers are first-guess. **Recalibrate after 2 weeks of real-printer use** — look at every user override in `centauri_review` where the user reassigned away from the top candidate, and adjust per-signal weights accordingly.
- **MD5 backfill cost.** For a library of N models with average size M, full hash sweep is O(N·M). At STLVault scale (single-user, hundreds-of-models max), this is fine — but the UX makes it visibly non-blocking with progress.
- **mDNS fragility on home networks.** Some routers don't bridge mDNS across VLANs / WiFi-isolation. Manual IP entry is the always-works fallback.
- **Spoolman coupling.** Auto-confirm fails open (falls through to inbox) when Spoolman is unreachable, ambiguous, or empty. This is more conservative than "log without spool" — users who don't run Spoolman won't ever see auto-confirm fire. Document this in Settings.

## Ship sequence

Three phases, each independently reviewable and each delivering user-visible value. Phase split revised from the original — Phase 1 used to be pure plumbing; it now ships the inbox shell too.

### Phase 1 — Connection + Inbox shell (~1 PR)

User-visible value: "I can see what my printer printed and dismiss it or pick a model manually."

- 30-minute SDCP-library spike **before** writing this PR (see Risks).
- Settings card with manual IP + mDNS discovery + Test connection.
- `CentauriClient` + connection management + reconnect logic + SDCP vendored module with upstream SHA.
- Schema migrations: all new Centauri tables + the `custom_prints` source/centauri_event_id columns (in `custom_prints/schema.py`).
- Event ingestion: detect job completion, download .3mf, parse metadata, write event row.
- Print Inbox view (`/inbox`) with **confirm-via-search-picker** and **dismiss** actions. (No matcher candidates yet — the picker is unfiltered model search.)
- SSE endpoint for inbox-badge live updates.

### Phase 2 — Matching + remaining actions (~1 PR)

User-visible value: "I open the inbox and the right model is already suggested. New-from-print and reserve work."

- Matcher (source-hash, filename, recent-slicer-open signals).
- MD5 backfill into `centauri_model_hash` (one-time, surfaced in Settings).
- Match suggestion strip in inbox cards.
- Review actions: reassign, create-from-this-print, reserve-for-upload.
- Upload page integration: "Link to a recent print?" banner when outstanding reserves exist.
- Filename normalisation per spec.

### Phase 3 — Auto-confirm + polish (~1 PR)

User-visible value: "The common case logs without my touching it."

- Auto-confirm gate (multi-signal AND + plate-transforms identity + spool resolution).
- 24-hour undo window on auto-matches.
- Spool-resolution UI (manual picker shown when ambiguous on the inbox path).
- Model detail panel: "Printed from Centauri" chip + "View source .3mf" link.
- Recent view chip for auto-matched entries.
- 30-day reserve expiry job.
- Last-N-jobs backfill on first connection.

## Out-of-scope follow-ups (separate cycles)

- Multi-printer support — schema for `centauri_print_event` is keyed by `printer_id`; `centauri_settings` becomes a multi-row `centauri_printer` table.
- Two-way control (send-to-printer, queue management, pause/cancel from STLVault).
- Live camera feed embedding.
- Other printer brands (Bambu native, Klipper/Moonraker, Prusa Connect). The matching + review architecture transfers, but each needs a printer-specific client.
- Slicer profile capture beyond the .3mf metadata (e.g. read OrcaSlicer's profile DB to capture full settings).
- Per-spoolman-spool weight reconciliation on a printer-reported actual vs. estimate delta beyond a threshold.

## Open questions

1. **Folder for "Create from this print" models.** Default to a system "Print Inbox" folder, drop into root, or prompt? Recommendation: system folder, named consistently with the inbox view.
2. **Multi-mesh auto-confirm.** v1 explicitly queues every multi-mesh event. Long-term, is there a useful "log this print against multiple models, splitting filament weight by mesh volume" feature? If so, that's a Phase 4 conversation, not now.
3. **Spool ΔE tolerance.** The auto-confirm spool-resolution uses a ΔE < 5 colour tolerance. Is that right for the dyed-PLA palette the user actually runs? May want tuning after real use.
4. **Job history backfill depth on first connection.** Hard-coded 50? Configurable? Most users print < 50 things they'd want to backfill; revisit if needed.
5. **30-day reserve expiry — auto-dismiss or surface a "you have N stale reserves" reminder first?** Recommendation: auto-dismiss with `reason='reserve_expired'`; show stale reserves in a Settings page if the user wants to see them.
