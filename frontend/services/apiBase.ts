// Single source of truth for the backend API base URL.
//
// Three resolution rules, in priority order:
//
//   1. `api-port-override` in localStorage — manual override for pointing
//      a local frontend at a remote backend. Includes the host:port.
//
//   2. Dev sentinel — `VITE_API_URL === "TERA_API_URL"` means Vite never
//      substituted the placeholder (we're in `npm run dev`), so we
//      use same-origin `/api/*` and let Vite's proxy forward to
//      :8000. See vite.config.ts → server.proxy["/api"].
//
//   3. Container / preview build — env.sh rewrote VITE_API_URL at
//      container startup to the real backend host (e.g.
//      "https://stlvault-api.example.com"). Concatenate `/api`.
//
// New service modules MUST import `resolveApiBase` from here rather
// than reproducing the logic — every duplicate is one more place to
// forget rule (2) and ship a broken integration on the dev server.

export const DEV_API_URL_SENTINEL = "TERA_API_URL";

export function resolveApiBase(): string {
  const override = localStorage.getItem("api-port-override");
  if (override) return override + "/api";
  if (import.meta.env.VITE_API_URL === DEV_API_URL_SENTINEL) return "/api";
  return import.meta.env.VITE_API_URL + "/api";
}
