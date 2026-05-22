# Centauri Carbon integration — design

_Plan date: 2026-05-22_

STLVault gains a fork-only integration with the Elegoo Centauri Carbon FDM printer. Goal: when a print finishes on the printer, STLVault learns about it automatically, matches it to a model in the library (or offers to create one), and writes a print log entry without the user re-typing time and filament numbers.

The integration is **auto-log with a review queue**: high-confidence matches log silently; everything else lands in an inbox the user clears at their pace.

## Scope

**In:**
- Long-running backend listener that speaks SDCP v3 to a Centauri Carbon over the LAN.
- A new `centauri_print_event` table capturing every job the printer finished (success / fail / cancel), independent of whether it was matched to a STLVault model.
- A matcher that proposes STLVault models for each event using source-hash, filename, and recent-slicer-open signals with a confidence score.
- A "Print Inbox" view (`/inbox`) with review actions: confirm, reassign, **create new model from this print's embedded source files**, **reserve placeholder for later upload**, dismiss.
- Auto-confirm at confidence ≥ 0.9 (i.e. source-hash match) — writes a Spoolman print log directly, surfaces a passive toast and a chip in the existing Recent view.
- Settings card under Settings → Centauri Carbon: LAN address, mDNS auto-discovery, connection status, "auto-confirm" toggle.

**Out (explicit YAGNI for v1):**
- Multi-printer dashboards. Schema supports `printer_id` but UI assumes one printer.
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
│   └─ persist event + match candidates
│                                │
│  REST/SSE endpoints under      │
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
2. **Matching.** A matcher pass scores each event against the model library and writes `centauri_match_candidate` rows (zero or more per event) with confidence + reason.
3. **Review.** The frontend surfaces unreviewed events. User decisions feed back into `centauri_review` and into the existing `custom_prints` table when a print log is created.

## Matching logic

Three signals, descending trust:

| Signal | Source | Confidence | Behavior |
|---|---|---|---|
| **Source-hash match** | MD5 of the embedded mesh in the .gcode.3mf, looked up against STLVault's stored model files | 1.0 | Auto-confirm (unless user disabled it) |
| **Embedded filename match** | Original `.stl` / `.3mf` filename inside the .3mf metadata, after stripping path + version suffix | 0.7 single hit, 0.4 multi-hit | Queue with top candidate pre-selected |
| **Recent slicer-open** | Model was opened via "Open in slicer" within ~60 min of the print start | 0.3 | Queue as weak suggestion |

The matcher writes a `match_candidate` row per signal that fires and an aggregate `confidence` on the event. Auto-confirm threshold is the highest signal's confidence — never an average. Source-hash is the only signal that auto-confirms.

## Review queue actions

Per event in the inbox:

- **Confirm top candidate** — write a `custom_prints` log entry. Pre-fill from .3mf metadata: estimated time, filament weight, profile name. Optional: printer-reported actual time when available.
- **Reassign** — pick a different existing model via a search/picker.
- **Create new model from this print** — extract the embedded STL/3MF from the .gcode.3mf, create a new STLVault model row with it as the source file, then attach the print log. Folder defaults to "Print Inbox" (a system folder we'll create on first use) or last-used folder.
- **Reserve for later upload** — write an "expected" placeholder model row with the gcode's filename and the parsed .3mf as a `pendingSource` attachment. When the user later uploads a file whose MD5 matches the placeholder's `pendingSource`, the upload flow auto-finalises the placeholder and the print log links naturally.
- **Dismiss** — calibration, test print, none-of-the-above. Event row stays in the DB (auditable, can be un-dismissed) but is hidden from the queue.

## UI surface

### Print Inbox (`/inbox`)

A new sidebar entry between Recent and Prints, with a numeric badge for unreviewed events. Visual style consistent with Recent / Tags (full main-area width, same header, `flex-1 overflow-y-auto` body — the `min-h-0` + `shrink-0` pattern we just learned from the detail-panel fix applies if we have a sticky filter bar).

Each event renders as a card showing:

- Thumbnail (extracted from the .3mf's plate preview PNG — OrcaSlicer always bundles one)
- Filename, start/end timestamps, outcome chip (`completed` / `failed` / `cancelled`)
- Time + filament-weight badges (estimate, with "act vs est" delta when the printer reported actuals)
- Match suggestion strip: top candidates' thumbnails, names, confidence dots (green ≥ 0.9, amber 0.4–0.9, red < 0.4). Click to confirm; "More…" opens the reassign picker.
- Action buttons: **Create from this print**, **Reserve for upload**, **Dismiss**.

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

## Backend internals

### Connection lifecycle

SDCP is WebSocket-based, so the natural model is a persistent connection, not polling. A `CentauriClient` singleton starts in FastAPI's `lifespan`, opens the WS to `ws://<printer-ip>:3030`, subscribes to status updates. Exposed surface:

- `status()` — current job, progress, temps (cached, refreshed on every push)
- `download_job_file(jobId)` — pulls the .gcode.3mf from the printer
- `events()` — async iterator of state transitions for the ingestion loop

### Resilience

- Printer offline → reconnect with exponential backoff (1s, 2s, 4s, 8s, capped at 60s). Status surfaced in `/api/centauri/status` so the UI can show "disconnected".
- STLVault backend restart → on startup, fetch printer's recent job history (SDCP exposes this) and reconcile against events we already have. Idempotent on `(printer_id, sdcp_job_id)`.
- Job already logged → re-detection is a no-op.
- WS connection failure must **not** fail the rest of the backend. The Centauri client is isolated; STLVault works without it.

### Schema (new, all under `custom_centauri/`)

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
  thumbnail_path TEXT,
  archived_3mf_path TEXT,
  raw_payload TEXT,           -- raw SDCP job JSON
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (printer_id, sdcp_job_id)
);

CREATE TABLE centauri_match_candidate (
  id INTEGER PRIMARY KEY,
  event_id INTEGER NOT NULL REFERENCES centauri_print_event(id),
  model_id TEXT NOT NULL,     -- FK soft, matches STLVault models.id
  signal TEXT NOT NULL,       -- 'source_hash' | 'embedded_filename' | 'recent_slicer_open'
  confidence REAL NOT NULL,
  reason TEXT
);

CREATE TABLE centauri_review (
  event_id INTEGER PRIMARY KEY REFERENCES centauri_print_event(id),
  reviewed_at TIMESTAMP NOT NULL,
  action TEXT NOT NULL,       -- 'confirm' | 'reassign' | 'create' | 'reserve' | 'dismiss' | 'auto'
  resulting_print_id INTEGER, -- FK to custom_prints when action created a print log
  resulting_model_id TEXT     -- FK soft to models.id when action created/reserved a model
);

CREATE TABLE centauri_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),  -- singleton
  printer_ip TEXT,
  printer_name TEXT,
  auto_confirm_enabled INTEGER NOT NULL DEFAULT 1,
  last_connected_at TIMESTAMP
);
```

The existing `custom_prints` table gains:

- `source TEXT NOT NULL DEFAULT 'manual'` — `'manual'` | `'centauri'`
- `centauri_event_id INTEGER NULL REFERENCES centauri_print_event(id)`

Bidirectional link so we can drill from a print log entry back to the printer event and vice versa.

### Storage

Archived `.gcode.3mf` files live under `${UPLOAD_PATH}/centauri/<printer_id>/<event_id>.gcode.3mf`. Bounded retention: keep the last 50 per printer, or 30 days, whichever is larger. A nightly cleanup task prunes.

Thumbnails (plate previews extracted from each .3mf) live under `${UPLOAD_PATH}/centauri/<printer_id>/thumbs/<event_id>.png`. Same retention as the parent .3mf.

## Onboarding flow

First-run under Settings → Centauri Carbon:

1. Auto-discover printers on the LAN via SDCP's mDNS broadcast (`_sdcp._tcp.local`). Show found printers as cards; click to add. Fallback to manual IP + port entry.
2. Test connection (single WS handshake + ping). On success, persist `{printer_id, name, ip, model}` to `centauri_settings`.
3. Kick off a one-time MD5 sweep over existing stored model files so matching works against the library already in place. Progress bar in Settings, non-blocking. We need this row in the models table going forward, so MD5 becomes a standard field — backfill is just retroactive.
4. Optional: pull the last N print jobs from the printer's history and create events for them. User can review or bulk-dismiss.

## Risks & trade-offs

- **SDCP API churn.** The protocol is community-documented at [docs.opencentauri.cc](https://docs.opencentauri.cc/software/api/) but Elegoo can change it on a firmware release. Mitigation: integration tests against fixtures captured from a real printer, and a defensive parser (unknown fields ignored, not crashed).
- **Library choice.** [pycentauri](https://github.com/bjan/pycentauri) is convenient but adds a dependency on a single maintainer's repo. If it gets stale, we're stuck. Recommendation: read its WS handler code, copy what we need into `custom_centauri/sdcp.py` (estimated ~300 lines), keep no runtime dep. License-permitting.
- **Matcher false positives.** Filename-only matches at 0.7 confidence can mismatch when you have e.g. `dragon_v1.stl` and `dragon_v2.stl`. Mitigation: never auto-confirm below source-hash (0.9+), always queue everything else.
- **MD5 backfill cost.** For a library of N models with average size M, full hash sweep is O(N·M). At STLVault scale (single-user, hundreds-of-models max), this is fine — but the UX needs to make it visibly non-blocking with progress.
- **Embedded source files in .gcode.3mf may be downsampled/repaired.** OrcaSlicer can repair meshes during slicing. The MD5 of the embedded mesh might not match the user's original STL. Mitigation: store the embedded mesh's hash alongside the model when "Create from this print" is used, so re-prints of the same slice still match. Document this in the matcher comments.
- **mDNS fragility on home networks.** Some routers don't bridge mDNS across VLANs / WiFi-isolation. Manual IP entry is the always-works fallback.

## Ship sequence

Three phases, three PRs. Each one independently reviewable and shippable.

### Phase 1 — Foundation (~1 PR)

- Settings card with manual IP + Test connection.
- `CentauriClient` + connection management + reconnect logic.
- Schema migrations (event + candidate + review + settings tables, plus `custom_prints` columns).
- Event ingestion: detect job completion, download .3mf, parse metadata, write event row. **No matching logic, no UI for review yet.**
- Endpoints: `GET /api/centauri/status`, `GET /api/centauri/events`.
- Goal: confirm the wire-level integration works on your printer before we invest in UX.

### Phase 2 — Matching + Inbox (~1 PR)

- Matcher (source-hash, filename, recent-slicer-open signals).
- MD5 backfill of existing models (one-time, surfaced in Settings).
- Print Inbox view (`/inbox`).
- Review actions: confirm, reassign, create-from-this-print, reserve-for-upload, dismiss.
- Sidebar entry + badge.
- Goal: full user-facing value end-to-end, but every match needs manual review.

### Phase 3 — Auto-confirm + polish (~1 PR)

- Auto-confirm threshold + toast.
- 24-hour undo window on auto-matches.
- Model detail panel: "Printed from Centauri" chip + "View source .3mf" link.
- Recent view chip for auto-matched entries.
- mDNS auto-discovery (replaces / augments manual IP entry).
- Last-N-jobs backfill on first connection.

## Out-of-scope follow-ups (separate cycles)

- Multi-printer support (the schema supports it; UI doesn't).
- Two-way control (send-to-printer, queue management, pause/cancel from STLVault).
- Live camera feed embedding.
- Other printer brands (Bambu native, Klipper/Moonraker, Prusa Connect). The matching + review architecture transfers, but each needs a printer-specific client.
- Slicer profile capture beyond the .3mf metadata (e.g. read OrcaSlicer's profile DB to capture full settings).

## Open questions

1. **Folder for "Create from this print" models.** Should we create a dedicated "Print Inbox" folder, drop into root, or prompt? Defaulting to a system folder seems least surprising.
2. **`pendingSource` matching window.** When the user later uploads, do we match against ALL placeholder rows ever, or only the last 30 days? 30 days seems reasonable — stale placeholders prompt the user to dismiss.
3. **Job history depth on backfill.** How many recent jobs do we pull on first connection? 50? Configurable? Probably just hard-code 50 and revisit.
