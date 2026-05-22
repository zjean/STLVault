import React, { useEffect, useState } from "react";
import { Check, CircleAlert, Loader2, Database } from "lucide-react";
import {
  spoolmanApi,
  SpoolmanApiError,
  SpoolmanSettings as SettingsDTO,
  SpoolSummary,
} from "../../services/custom-spoolman";

// Fork-only: Settings → Spoolman panel.
//
// Three observable states drive UX:
//   loading    — first GET /settings in flight
//   unconfigured — no baseUrl saved
//   configured — baseUrl present; enable toggle drives downstream features
//
// The Test button operates on the current form values, not the saved
// values, so the user can verify a URL before committing.

type Phase = "loading" | "ready";
type TestState =
  | { kind: "idle" }
  | { kind: "testing" }
  | { kind: "ok"; version: string }
  | { kind: "fail"; message: string };

const SpoolmanSettings: React.FC = () => {
  const [phase, setPhase] = useState<Phase>("loading");
  const [saved, setSaved] = useState<SettingsDTO | null>(null);

  // Edit-buffer mirrors the saved values until the user types.
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [enabled, setEnabled] = useState(false);
  // Track whether the user touched apiKey — empty string + untouched means
  // "leave saved key alone"; empty string + touched means "clear it".
  const [apiKeyTouched, setApiKeyTouched] = useState(false);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [testState, setTestState] = useState<TestState>({ kind: "idle" });

  // Preview of spools fetched from the configured Spoolman — gives instant
  // confirmation the wiring works (and what colors/labels look like).
  const [spools, setSpools] = useState<SpoolSummary[] | null>(null);
  const [spoolsError, setSpoolsError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const s = await spoolmanApi.getSettings();
        setSaved(s);
        setBaseUrl(s.baseUrl ?? "");
        setEnabled(s.enabled);
        setPhase("ready");
        if (s.enabled && s.baseUrl) void refreshSpools();
      } catch (e) {
        setSaveError(
          e instanceof Error ? e.message : "Failed to load Spoolman settings",
        );
        setPhase("ready");
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refreshSpools = async () => {
    try {
      setSpoolsError(null);
      const list = await spoolmanApi.listSpools();
      setSpools(list);
    } catch (e) {
      setSpools(null);
      setSpoolsError(
        e instanceof SpoolmanApiError
          ? e.message
          : e instanceof Error
            ? e.message
            : "Failed to fetch spools",
      );
    }
  };

  const handleTest = async () => {
    setTestState({ kind: "testing" });
    try {
      const r = await spoolmanApi.testConnection({
        baseUrl: baseUrl.trim() || null,
        apiKey: apiKeyTouched ? apiKey.trim() || null : undefined,
      });
      if (r.ok) {
        setTestState({ kind: "ok", version: r.version ?? "(unknown)" });
      } else {
        // Prepend HTTP status when present — "401: Unauthorized" tells the
        // user this is an auth problem, not a network one.
        const msg = r.error ?? "Connection failed";
        const prefix = r.status && r.status > 0 ? `${r.status}: ` : "";
        setTestState({ kind: "fail", message: prefix + msg });
      }
    } catch (e) {
      setTestState({
        kind: "fail",
        message: e instanceof Error ? e.message : "Test failed",
      });
    }
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      const payload: Parameters<typeof spoolmanApi.saveSettings>[0] = {
        baseUrl: baseUrl.trim() || null,
        enabled,
      };
      // Only include apiKey in the payload if the user touched it.
      if (apiKeyTouched) payload.apiKey = apiKey.trim() || null;
      const s = await spoolmanApi.saveSettings(payload);
      setSaved(s);
      setApiKey("");
      setApiKeyTouched(false);
      if (s.enabled && s.baseUrl) void refreshSpools();
      else setSpools(null);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  if (phase === "loading") {
    return (
      <div className="text-[13px] text-fg-3 inline-flex items-center gap-2">
        <Loader2 size={14} className="animate-spin" /> Loading Spoolman
        settings…
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <form onSubmit={handleSave} className="space-y-3 max-w-[560px]">
        <div>
          <label
            htmlFor="spoolman-base-url"
            className="block text-[12.5px] font-medium text-fg-2 mb-1.5"
          >
            Base URL
          </label>
          <input
            id="spoolman-base-url"
            type="url"
            inputMode="url"
            placeholder="http://localhost:7912/api/v1"
            value={baseUrl}
            onChange={(e) => {
              setBaseUrl(e.target.value);
              setTestState({ kind: "idle" });
            }}
            className="w-full font-mono px-3 py-2.5 bg-surface border border-border rounded-lg text-[13px] text-fg outline-none focus:border-accent focus:ring-[3px] focus:ring-accent/15 transition-all"
          />
          <p className="text-[12px] text-fg-3 mt-1">
            Include the <code className="font-mono">/api/v1</code> suffix.
            Local dev: <code className="font-mono">http://localhost:7912/api/v1</code>.
          </p>
        </div>

        <div>
          <label
            htmlFor="spoolman-api-key"
            className="block text-[12.5px] font-medium text-fg-2 mb-1.5"
          >
            API key / bearer token{" "}
            <span className="font-normal text-fg-3">(optional)</span>
          </label>
          <input
            id="spoolman-api-key"
            type="password"
            placeholder={
              saved?.hasApiKey
                ? "•••••••• (saved — type to replace, clear to remove)"
                : "Only if a reverse proxy in front of Spoolman requires one"
            }
            value={apiKey}
            onChange={(e) => {
              setApiKey(e.target.value);
              setApiKeyTouched(true);
              setTestState({ kind: "idle" });
            }}
            className="w-full font-mono px-3 py-2.5 bg-surface border border-border rounded-lg text-[13px] text-fg outline-none focus:border-accent focus:ring-[3px] focus:ring-accent/15 transition-all"
          />
        </div>

        <label className="inline-flex items-center gap-2.5 text-[13px] text-fg cursor-pointer select-none">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            className="w-4 h-4 accent-accent"
          />
          Enable Spoolman integration
        </label>

        <div className="flex items-center gap-2 flex-wrap pt-1">
          <button
            type="submit"
            disabled={saving}
            className="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg bg-accent text-accent-fg text-[13px] font-semibold hover:brightness-105 transition-all disabled:opacity-50"
          >
            {saving ? (
              <>
                <Loader2 size={14} className="animate-spin" /> Saving…
              </>
            ) : (
              "Save"
            )}
          </button>
          <button
            type="button"
            onClick={() => void handleTest()}
            disabled={!baseUrl.trim() || testState.kind === "testing"}
            className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-border bg-surface hover:bg-surface-2 text-[13px] text-fg-2 transition-colors disabled:opacity-50"
          >
            {testState.kind === "testing" ? (
              <>
                <Loader2 size={13} className="animate-spin" /> Testing…
              </>
            ) : (
              "Test connection"
            )}
          </button>

          {testState.kind === "ok" && (
            <span className="inline-flex items-center gap-1.5 text-[12px] text-success font-medium">
              <Check size={13} /> Spoolman v{testState.version}
            </span>
          )}
          {testState.kind === "fail" && (
            <span className="inline-flex items-start gap-1.5 text-[12px] text-danger font-medium max-w-[320px]">
              <CircleAlert size={13} className="mt-0.5 flex-shrink-0" />
              <span className="break-words">{testState.message}</span>
            </span>
          )}
        </div>

        {saveError && (
          <div className="p-3 bg-danger/10 border border-danger/30 rounded-lg text-[12.5px] text-danger">
            {saveError}
          </div>
        )}
      </form>

      {/* Spool preview — only shown when integration is enabled + configured. */}
      {saved?.enabled && saved.baseUrl && (
        <div className="pt-3 border-t border-border-soft">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2 text-[13px] font-medium text-fg-2">
              <Database size={14} /> Spools available
            </div>
            <button
              type="button"
              onClick={() => void refreshSpools()}
              className="text-[12px] text-fg-3 hover:text-fg transition-colors"
            >
              Refresh
            </button>
          </div>

          {spoolsError && (
            <div className="p-3 bg-danger/10 border border-danger/30 rounded-lg text-[12.5px] text-danger">
              {spoolsError}
            </div>
          )}

          {!spoolsError && spools && spools.length === 0 && (
            <p className="text-[12.5px] text-fg-3">
              No spools in Spoolman yet. Add some over in the Spoolman web UI,
              then click Refresh.
            </p>
          )}

          {!spoolsError && spools && spools.length > 0 && (
            <ul className="space-y-1.5">
              {spools.map((s) => (
                <li
                  key={s.id}
                  className="flex items-center gap-3 px-3 py-2 bg-surface border border-border-soft rounded-lg text-[13px]"
                >
                  <span
                    aria-hidden
                    className="w-4 h-4 rounded-full border border-border-soft flex-shrink-0"
                    style={{
                      backgroundColor: s.colorHex ? `#${s.colorHex}` : "#888",
                    }}
                    title={s.colorHex ? `#${s.colorHex}` : ""}
                  />
                  <span className="flex-1 min-w-0 truncate text-fg">
                    {s.label}
                    {s.material && (
                      <span className="text-fg-3"> • {s.material}</span>
                    )}
                  </span>
                  <span className="font-mono text-[12px] text-fg-2 flex-shrink-0">
                    {s.remainingWeight != null
                      ? `${Math.round(s.remainingWeight)} g`
                      : "—"}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
};

export default SpoolmanSettings;
