---
name: stlvault-dev-loop-verify
description: Browser-verify a STLVault frontend change against the local Vite dev server using chrome-devtools MCP. Use this skill whenever the user asks to "test in browser", "verify in the dev server", "load the app and check", "does the viewer render right", "screenshot the change", "smoke-test the upload/download/viewer/dialog", or when proposing any frontend change that needs visual confirmation before reporting it complete. Also use proactively after editing files under `frontend/components/` (especially the 3D viewer, file upload/drag-drop, dialogs, or any custom-* code) if the change is visual or behavioral — the local dev server is the only way to catch bugs like the filename-as-UUID regression (PR #30) that slip past `vite build`. Covers the loopback-hijack workaround, FastAPI fixture creation, 3D-viewer render verification, MUI theme audits, screenshot capture in MCP-allowed paths, and edit-then-save round-trip verification.
---

# Verifying STLVault changes against the local dev server

A STLVault frontend change can pass `vite build` and TypeScript checks and still ship broken. Static checks won't catch:

1. **The download-filename regression** (PR #30, commits `493bf59` / `681c518` / `99304f3`) — downloads were saving files under their UUID instead of the human-readable model name. Build was clean; only running an actual download in the browser revealed it.
2. **3D viewer rendering issues** — three.js / react-three-fiber problems (wrong camera, broken lighting, missing geometry on certain file types) compile fine but render a black canvas.
3. **MUI theme / Emotion token issues** — visual regressions in dialogs, contrast issues, palette tokens reaching for missing fallbacks.
4. **File upload / drag-and-drop flows** — drop targets that don't fire, multipart bodies that the FastAPI side rejects, progress UI that doesn't update.

This skill is the recipe for catching these by exercising the change end-to-end in a real browser via the `chrome-devtools` MCP. It assumes the dev stack is already running — if it isn't, ask the user to start it. Don't try to spin it up yourself; the backend needs DB + env config that's user-specific.

## Step 1 — Find the dev server and dodge the loopback hijack

The STLVault dev stack:
- **Frontend (Vite)**: `:5173` by default (Vite's standard). Configurable via `vite.config.ts`.
- **Backend (FastAPI)**: `:8080` in the Dockerfile, `:8998` per the README's compose example. Whichever the user runs.

On the maintainer's machine, **VS Code's helper process listens on `127.0.0.1:<port>`**, so `curl http://localhost:5173/` and `chrome-devtools new_page http://localhost:5173/` may time out. The dev servers bind `*:<port>` and are reachable via the LAN IP. The Code Helper hijacks loopback specifically; LAN addresses work.

```bash
# Confirm the frontend is running (you want a `node` process).
lsof -nP -iTCP:5173 -sTCP:LISTEN
# Expect:  node  <PID>  ... TCP *:5173 (LISTEN)
# Sometimes also: Code Helper  <PID>  ... TCP 127.0.0.1:5173 (LISTEN)  ← the hijacker

# Confirm the backend.
lsof -nP -iTCP:8080 -sTCP:LISTEN  # or :8998 depending on user setup

# Discover the active LAN IP.
/sbin/ifconfig en0 | rtk proxy grep 'inet '
```

From here on every URL in the skill uses the LAN IP — `http://192.168.x.x:5173/` for the frontend — not `localhost`. Substitute the actual IP you found.

If `lsof` returns empty for the frontend, tell the user the dev server isn't running and ask them to start it (`npm --prefix frontend run dev`). Don't guess. If the backend is down too, mention both.

## Step 2 — Open the app

```javascript
// chrome-devtools: new_page → http://<LAN-IP>:5173/
// STLVault has no login flow (single-user, auth is on the roadmap as unchecked).
// You land directly on the dashboard.
take_snapshot
```

Confirm you see the sidebar with folders (e.g. "All Models"), the main grid, and the search box. If you get a blank page, check the browser console (`list_console_messages`) — a Vite error overlay usually means the dev server is mid-restart; wait and retry.

## Step 3 — Create test fixtures via the FastAPI

STLVault is single-user with no CSRF / auth, so `fetch()` calls inside `evaluate_script` work without any token plumbing. The API is the FastAPI app in `backend/app.py` — read it (or the OpenAPI at `http://<LAN-IP>:8080/docs`) for the current endpoint list.

A typical fixture pattern — upload a small test STL via multipart:

```javascript
async () => {
  // Tiny valid binary STL header (80-byte comment + 4-byte triangle count = 0).
  const header = new Uint8Array(80)
  const triCount = new Uint8Array([0, 0, 0, 0])
  const blob = new Blob([header, triCount], { type: 'application/octet-stream' })

  const form = new FormData()
  form.append('file', new File([blob], 'smoke-test.stl', { type: 'application/octet-stream' }))

  // Adjust the URL to whatever the current upload endpoint is — check the OpenAPI.
  const r = await fetch('http://<LAN-IP>:8080/api/upload', { method: 'POST', body: form })
  return { status: r.status, body: await r.text() }
}
```

For listing / reading-back fixtures, no special headers needed — just same-origin (or cross-origin if CORS is enabled) `fetch()`.

When the model has a known filename like `smoke-test.stl`, you can use it in download / viewer URL assertions later — that's how you catch the PR #30 class of bug: the saved file name should match `smoke-test.stl`, not a UUID.

## Step 4 — Navigate to the change and snapshot

```
navigate_page → http://<LAN-IP>:5173/<route-for-the-change>
wait_for      → any string you expect on the rendered page (e.g. the model name in a viewer, or a dialog title)
take_snapshot → structural confirmation; check the right component mounted
```

Common routes (verify against the current `App.tsx` / router):
- `/` — dashboard / folder list
- `/model/<id>` — model detail / 3D viewer
- `/settings` — settings page

Use `take_screenshot` for visual confirmation. **Path gotcha**: chrome-devtools enforces workspace roots; `/tmp/foo.png` is rejected. Save under `$TMPDIR` (which on macOS resolves to something like `/var/folders/zc/.../T/`) or under the repo. The repo path keeps screenshots reviewable later but bloats the workspace; `$TMPDIR` is fine for throwaway smoke tests. Then `Read` the file path to surface it inline for the user.

## Step 5 — Verify the 3D viewer actually rendered

The 3D viewer (`@react-three/fiber` + `three`) renders into a `<canvas>` element. A broken viewer compiles fine but presents either a black canvas or a missing one. Smoke-check both:

```javascript
() => {
  const canvases = Array.from(document.querySelectorAll('canvas'))
  if (canvases.length === 0) return { error: 'no canvas mounted — viewer did not render' }

  const results = canvases.map((c) => {
    const ctx = c.getContext('webgl2') || c.getContext('webgl')
    const rect = c.getBoundingClientRect()
    return {
      size: { w: rect.width, h: rect.height },
      hasContext: !!ctx,
      // Sample a pixel from the centre — if the viewer rendered a model,
      // it won't be uniform background.
      // (For webgl, we'd need to readPixels; for a quick check, just confirm dimensions.)
      visible: rect.width > 100 && rect.height > 100
    }
  })
  return results
}
```

If `hasContext` is false or `visible` is false, the viewer isn't actually rendering. Check the console for shader compile errors or three.js warnings (`list_console_messages`). Common culprits: a malformed STL parser path, OCCT-import-js (`occt-import-js`) failing to load WASM, camera placed inside the geometry.

For a thorough render check, take a screenshot and inspect visually — the model should be discernible against the background.

## Step 6 — Audit MUI / Emotion theme (when a visual regression is suspected)

STLVault uses MUI v7 + Emotion. Token resolution issues here are less catastrophic than the design-token mismatches in the sister sync-in fork (no fork-specific palette layered on top), but a misuse of `theme.palette.<X>` or a hard-coded color that doesn't respect the active theme is still possible.

Walk from the suspect leaf up to the theme provider:

```javascript
() => {
  // Pick the leaf — e.g. dialog text, a button label, the file name in the grid.
  const leaf = document.querySelector('[role="dialog"]') || document.querySelector('main')
  if (!leaf) return { error: 'leaf selector did not match — adjust' }
  const trail = []
  let el = leaf
  while (el && el !== document.documentElement) {
    const cs = getComputedStyle(el)
    trail.push({
      tag: el.tagName.toLowerCase() + (el.className ? '.' + String(el.className).split(/\s+/).slice(0, 2).join('.') : ''),
      color: cs.color,
      bg: cs.backgroundColor
    })
    el = el.parentElement
  }
  return trail
}
```

Smoking-gun patterns:
- Near-white text (`rgb(245+, ...)`) on a near-white background (`rgb(255, 255, 255)` or `rgba(0, 0, 0, 0)` resolving to white through the parent) → contrast bug.
- Inline `style="color: #..."` or `style="background: #..."` on a component that should be using `theme.palette` → hard-coded color, breaks theme switching.
- Components using `sx={{ color: 'foo.bar' }}` where `foo.bar` is not in the active theme → MUI silently emits empty and the parent's color leaks.

## Step 7 — Exercise download / upload / drag-drop round-trips

The PR #30 family of bugs (filename mishandling) only surfaces in real round-trips. Don't trust visual confirmation alone — actually click Download and inspect the saved filename:

```javascript
// Pattern: click the Download button, then inspect the most recent network response
// for the Content-Disposition header.
// chrome-devtools list_network_requests after the click; find the download response;
// confirm Content-Disposition: attachment; filename="<expected-name>.stl"
```

For upload / drag-drop, dispatching a synthetic `DragEvent` with a `DataTransfer` payload is the right hammer in headless browsing — but be aware some libraries gate on `dataTransfer.types.includes('Files')` and some only respond to real OS drops. If a synthetic drop doesn't fire the handler, fall back to driving the visible "Upload" button (if present) with `click()` and a `change` event on the file input.

For the API path verification, fetch the model back via the same endpoint the UI uses and confirm the returned content matches what you uploaded. If the file you get back differs from what you put in, that's a backend-side bug — not a UI bug.

## Step 8 — Clean up

Test files left in `/uploads/` accumulate. At the end of a session, delete any smoke-test fixtures you created via the API:

```javascript
async () => {
  // Adjust the URL to whatever the current delete endpoint is.
  const r = await fetch('http://<LAN-IP>:8080/api/models/<id>', { method: 'DELETE' })
  return { status: r.status }
}
```

Or leave them — STLVault's storage isn't precious, and a known-good fixture is useful for the next round.

## Reporting back to the user

If a human is watching the session: surface a screenshot via `Read` after `take_screenshot` so the rendered state appears inline. Pair it with any computed-style trail or network-request data for the specific bug class. Quote concrete uids when describing what's on the page; don't say "the viewer" without anchoring it.

If the smoke run found a real bug (filename mismatch, viewer not rendering, theme regression, upload rejected), state it clearly with the smoking-gun evidence — the actual saved filename for the PR #30 family, the empty canvas for the viewer family, the contrast pair for the theme family. Don't bury it in a list of things-that-worked.

## When this skill doesn't apply

- The change is purely backend / non-visual: just run the FastAPI directly (or its tests, when they exist). This skill is overkill.
- The dev server isn't running and the user is mid-flow: ask before spending tool calls trying to start it. Spin-up needs DB + env knowledge that's user-specific.
- The change is in `backend/custom_*` and only affects the API contract: smoke-test via `curl` or `httpie` against `http://<LAN-IP>:8080/`, then optionally open the frontend to confirm the new contract renders right. Step 5 (3D viewer audit) is not relevant for non-viewer changes.
