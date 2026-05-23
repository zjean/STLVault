# Centauri Carbon integration — follow-up

_Date: 2026-05-23. Supplements [2026-05-22-centauri-integration-design.md](./2026-05-22-centauri-integration-design.md)._

The original design predates two weeks of building against a live Centauri Carbon. The implementation surfaced facts the design assumed but couldn't verify — chiefly **the printer doesn't store the slicer's `.gcode.3mf`** — and pushed two design corners (reserve-for-upload, file-download) into shape. This doc captures the deltas. Treat it as the source of truth for what's true today; the original stays unmodified as the design-time snapshot.

## What's shipped

| Phase | PR | Lands |
|---|---|---|
| 1 — Connection + Inbox shell | [#52](https://github.com/zjean/STLVault/pull/52) | SDCP WS client, settings card, inbox view, manual confirm/dismiss |
| 2 — Events emit + filename matcher + candidate strip | [#53](https://github.com/zjean/STLVault/pull/53) | Active bootstrap (Cmd 1 + 0 + 512), filename normaliser, candidate chips |
| 2.1 — Reserve-for-upload + post-upload link dialog | [#54](https://github.com/zjean/STLVault/pull/54) | `reserve` action, 30-day expiry, upload-page auto-tick dialog |
| 2.2 — Gcode pull + parse + archive + `printer_filename` matcher | [#55](https://github.com/zjean/STLVault/pull/55) | Cmd 321 enrichment, OrcaSlicer header parser, per-printer archive, second matcher signal |

The order matches PR-merge order, not the original design's "Phase 2 / Phase 3" split. The original Phase 2 fanned out into three independently shippable PRs (#53, #54, #55) once we hit the file-download question.

## Findings that changed the design

### The Centauri stores `.gcode`, not `.gcode.3mf`

Three independent observations converged:

1. **SDCP Cmd 258 LIST_FILES `/local/`** returns OrcaSlicer-named `.gcode` files only. No `.3mf`, no `.gcode.3mf`. Cmd 320 GET_HISTORY returns task UUIDs whose corresponding files (via Cmd 321) are also `.gcode`.
2. **The printer's own web UI bundle** (chunk `590.ad983f7d75c06e07fff5.js`) hard-codes a `/\.gcode$/i` regex in `beforeUpload`. The Import button refuses anything that isn't plain `.gcode`. So even the official client can't put a `.gcode.3mf` on disk on this firmware.
3. **WS sniff of the printer's web UI** confirmed it only sends cmds {0, 1, 134, 258, 320, 321, 386, 512}. No upload/download cmd surfaces a 3MF path.

OrcaSlicer / Elegoo Slicer can export `.gcode.3mf` to disk, but the "Send to printer" path transcodes to plain `.gcode` before transmitting. The bundle never reaches the printer.

**Implication.** The original design's source-hash matcher (signal #1 at confidence 0.85), `centauri_model_hash.embedded_md5`, and "Create from this print" all require the embedded STL — which doesn't exist on the printer. These features remain **blocked on a user-side drag-and-drop gesture**, not on more printer-API spelunking. The deeper API audit is closed: there's nothing there.

### The printer's HTTP file server is the file-download story

The thumbnail proxy in PR #52 hinted at it; PR #55 confirmed:

- **HTTP GET `http://<printer><TaskName>`** returns the sliced gcode as `text/plain; charset=utf-8`. Plain HTTP, no auth. Discovered via SDCP Cmd 321 returning `TaskName=/local/...gcode`.
- **No range requests needed** — typical sliced gcode is 1–10 MB.
- Same mechanism serves the per-print `*.mp4` time-lapse files visible on the printer UI's Video List. Not consumed yet.

The "drag-and-drop question" in PR #53's writeup is therefore answered for `.gcode` (yes, automatic) but stays open for `.gcode.3mf` (still drag-and-drop only).

### OrcaSlicer's gcode header is matcher gold

The downloaded `.gcode` files contain the slicer's full config + a `filename_format` template embedded in the CONFIG_BLOCK:

```
; filename_format = ECC_{nozzle_diameter[0]}_{input_filename_base}_{filament_type[0]}{layer_height}_{print_time}.gcode
```

Applied as a regex against the actual filename (`ECC_0.4_dragon_PLA0.12_4h25m.gcode`), `input_filename_base` recovers as `dragon` — the user-facing name from before the slicer prefixed it. The original filename normaliser would normalise the prefix-heavy name to `ecc_0.4_dragon_pla0.12_4h25m` and find nothing.

PR #55 introduces the **`printer_filename` matcher signal** at confidence **0.8 single-hit / 0.5 multi-hit** — strictly higher than the generic stem signal (0.7 / 0.4) because the template-extracted name has far fewer false positives. Both signals can coexist on one event; the highest-confidence hit drives the inbox's primary CTA.

Filament weight (`; total filament used [g]`), estimated time, slicer version, and printer model all come for free from the same parse pass. The inbox card now carries a filament-weight badge (e.g. `1.7g`); the event row carries the printer-side `MD5` from Cmd 321 for cheap "did I re-print the same slice?" later.

### Two undocumented SDCP commands

The printer's web UI uses two cmds beyond the OpenCentauri docs:

| Cmd | Purpose | Request | Response |
|---|---|---|---|
| **134** | Session-init / client identify | `{}` | `{Ack: 0}` |
| **386** | Enable live MJPEG stream | `{Enable: 1}` | `{Ack: 0, VideoUrl: "<ip>:3031/video"}` |

Neither is used in STLVault yet. 386 unlocks the live-camera-embed feature flagged out-of-scope in the original design's YAGNI list — implementable in a small future PR if the demand surfaces. 134 looks decorative and we don't need it.

### Reserve-for-upload reshaped the auto-confirm gate

The original design's Phase-3 auto-confirm gate required a multi-signal AND including **source-hash**. With source-hash off the table for printer-driven events, the realistic gate is:

- `filename` signal hit AND `printer_filename` signal hit against the **same** model_id, AND
- both signals at single-hit confidence (i.e. unambiguous), AND
- spool-resolution policy selects a single spool with `>0g` (unchanged), AND
- `centauri_settings.autoConfirmEnabled = 1`.

The "no scale ≠ 1.0, no per-instance transforms" precondition was a `.gcode.3mf`-only check — the printer-side `.gcode` is already-applied transforms. Drop it. Multi-mesh is also a `.gcode.3mf` concept; from the printer's perspective every print is single-mesh (the slicer flattened it).

PR #54's reserve flow handles the "user uploads later" case end-to-end without needing the auto-confirm gate at all, so the gate is now strictly an optimisation for the "user already has the model" common case. The cost of getting it wrong is lower than the design feared (one wrong print log, undoable via the 24-hour window from Phase 3).

## Revised forward plan

### Phase 3 — Auto-confirm + polish (still up next)

User value: "the common case logs without my touching it."

- **Auto-confirm gate** with the revised two-signal rule above.
- 24-hour undo window on auto-matches.
- Spool-resolution UI (manual picker shown when ambiguous on the inbox path) — unchanged from original.
- Model detail panel: "Printed from Centauri" chip + "View source .gcode" link (renamed from "View source .3mf" — accurate now).
- Recent view chip for auto-matched entries.
- The 30-day reserve expiry already lands in PR #54; no work here.
- Last-N-jobs backfill on first connection — pull Cmd 320 then per-task Cmd 321 + matcher run. Same enrichment pipeline as live events.

Spool-resolution policy gets one tweak: the gcode's `; filament_density = 1.24` + `; filament: 1` (the extruder count) lets us match filament *type* with higher confidence than the original design's `color_hex` ΔE-tolerance dance assumed. The Centauri's status push also reports the actual material vendor when an Elegoo-tag spool is loaded — worth folding into the resolver later.

### Phase 4 — Drag-and-drop `.gcode.3mf` (unblocks source-hash + create-from-this-print)

User value: "I have the slicer's `.gcode.3mf` on disk — let STLVault read the embedded mesh hash and link it to a real model, or create one."

- New drop target on inbox event cards: "Drop the slicer's `.gcode.3mf` for this print here."
- Endpoint `POST /api/centauri/events/{id}/attach-3mf` accepts the multipart upload.
- New `gcode3mf_meta` parser: unzip → `Metadata/model_settings.config` → embedded mesh files → MD5 each → plate-preview PNG → write `centauri_print_event.archived3mfPath` + per-mesh hashes to a new `centauri_event_mesh` table.
- **Source-hash matcher signal** lights up: cross-reference embedded mesh MD5s against `centauri_model_hash` (which still needs the backfill — see below).
- **Create-from-this-print** action: extract the first mesh as the new model's source STL, drop into a system "Print Inbox" folder, attach the print log.

### Phase 4.x — MD5 backfill (orthogonal, can land anytime)

Compute MD5 of every existing STLVault model's source file, write to `centauri_model_hash`. Settings card progress. Cheap to implement; only useful once Phase 4 lands, so deferred.

### Phase 5 (deferred indefinitely) — Multi-printer, live cam, two-way control, slicer profile capture

Unchanged from the original. SDCP Cmd 386 is the entry point for live cam if/when it surfaces as a priority. Multi-printer needs the schema split (`centauri_settings` → `centauri_printer` table) called out in the original.

## Updated open questions

The original five open questions resolve as follows:

| # | Question | Resolution |
|---|---|---|
| 1 | Folder for "Create from this print" models | Still TBD — same as original. Recommendation stands: system "Print Inbox" folder. |
| 2 | Multi-mesh auto-confirm | Moot for printer-driven events (no multi-mesh visible). Re-opens in Phase 4 for user-uploaded `.gcode.3mf`. |
| 3 | Spool ΔE tolerance | Defer until Phase 3 spool-resolution lands and we see real data. The gcode header gives us material type unambiguously; colour disambiguation is the only remaining ΔE case. |
| 4 | History backfill depth | Cmd 320 returns task UUIDs without a built-in count limit (the printer returned 40+ in one frame in testing). 50 is fine; tunable in Settings if it ever becomes annoying. |
| 5 | 30-day reserve expiry — auto-dismiss vs surface stale | **Resolved** as auto-dismiss with `reason='reserve_expired'`. Shipped in PR #54. |

## Operational learnings

### Don't fan-out-probe unknown SDCP commands

While sweeping cmds 2–520 with ~50ms between probes against the live printer, the printer's user-space services crashed: HTTP port 80 stopped responding, WS port 3030 went silent, ping still answered. Recovery took longer than the test cycle allowed; effectively required a power cycle.

**Rule.** Only send SDCP cmds we know are accepted by this firmware. If we need to learn a new one, learn it from the printer's own UI traffic (WebSocket sniffing via browser MCP, as used to discover 134 and 386), not by enumeration. Add new cmds to `sdcp.Cmd` only with this evidence.

### The cache-key for inbox-fresh-events is `(printerId, sdcpJobId)`

The design called this out at the schema level (`UNIQUE`) but PR #53 made it load-bearing for the ingest callback's "skip side effects on duplicate insert" path. The `ON CONFLICT (printerId, sdcpJobId) DO NOTHING` returning a zero `rowcount` is the signal — checking `cur.lastrowid` is wrong (it's 0 not None on no-op). Documented in `repo.insert_event`.

### Wire-level logging is INFO during stabilisation

PR #53 noted this and we've kept it through PR #55. Demote to DEBUG before opening a public release. A flag-gated `log.isEnabledFor(...)` check would let us flip it without redeploying; not worth the wiring yet.

### Browser-driven WS sniffing beats source-code reading

Reverse-engineering the printer's web UI via `chrome-devtools-mcp` (page-level `WebSocket` constructor wrap, `initScript` to install it before first connect) surfaced Cmd 134 and Cmd 386 in minutes. Grepping the minified bundle for the same numbers turned up nothing — the cmds aren't referenced as `"Cmd": N` string literals. The traffic is the source of truth; the source code is obfuscation.

## What's true today (one-line reference)

- **Detection:** Cmd 1 + 0 + 512 bootstrap on WS connect, Status pushes every 5s, terminal transition spawns enrichment.
- **Enrichment:** Cmd 321 → HTTP GET `<TaskName>` → parse OrcaSlicer header → archive under `${UPLOAD_PATH}/centauri/<printer>/<startedAt>_<task_prefix>.gcode` (≤50 files / ≤30 days retention).
- **Matching:** two signals (`filename` 0.7/0.4 and `printer_filename` 0.8/0.5), top hit drives the inbox card.
- **Review actions:** `confirm | dismiss | reserve`. Reserved events stay in the inbox; auto-flipped to `dismiss` after 30 days with `reason='reserve_expired'`.
- **Post-upload link:** after every successful `executeUpload`, the dialog auto-ticks reserves whose stem matches the upload and writes print logs in batch.
- **Open user gestures:** drag-and-drop `.gcode.3mf` (Phase 4) → source-hash matcher + create-from-print + better filament identity.
- **Don't:** probe undocumented SDCP cmds. WS-sniff the printer's own UI instead.
