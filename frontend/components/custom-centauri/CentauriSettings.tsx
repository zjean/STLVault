import React, { useEffect, useState } from "react";
import {
  Check,
  CircleAlert,
  Database,
  Loader2,
  Printer,
  Radio,
} from "lucide-react";
import {
  centauriApi,
  CentauriApiError,
  CentauriSettings as SettingsDTO,
  CentauriStatus,
  DiscoveredPrinter,
} from "../../services/custom-centauri";

// Fork-only: Settings → Centauri Carbon panel. Mirrors the SpoolmanSettings
// shape (load → edit → test → save) and uses the same design tokens so
// the two sit alongside each other consistently.

type Phase = "loading" | "ready";
type TestState =
  | { kind: "idle" }
  | { kind: "testing" }
  | { kind: "ok"; mainboardId: string | null }
  | { kind: "fail"; message: string };

type DiscoverState =
  | { kind: "idle" }
  | { kind: "scanning" }
  | { kind: "done"; results: DiscoveredPrinter[] }
  | { kind: "fail"; message: string };

const CentauriSettings: React.FC = () => {
  const [phase, setPhase] = useState<Phase>("loading");
  const [saved, setSaved] = useState<SettingsDTO | null>(null);
  const [status, setStatus] = useState<CentauriStatus | null>(null);

  const [printerIp, setPrinterIp] = useState("");
  const [printerName, setPrinterName] = useState("");
  const [autoConfirm, setAutoConfirm] = useState(true);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [testState, setTestState] = useState<TestState>({ kind: "idle" });
  const [discoverState, setDiscoverState] = useState<DiscoverState>({ kind: "idle" });

  // Phase-4.x model-hash backfill — populates centauri_model_hash for
  // existing library entries so source_hash matching works
  // retroactively. One-shot; idempotent — re-running just skips
  // already-hashed models.
  type BackfillState =
    | { kind: "idle" }
    | { kind: "running" }
    | {
        kind: "done";
        processed: number;
        skippedExisting: number;
        missingFile: number;
        errors: number;
      }
    | { kind: "fail"; message: string };
  const [backfillState, setBackfillState] = useState<BackfillState>({
    kind: "idle",
  });

  const handleBackfill = async () => {
    setBackfillState({ kind: "running" });
    try {
      const stats = await centauriApi.backfillHashes();
      setBackfillState({
        kind: "done",
        processed: stats.processed,
        skippedExisting: stats.skipped_existing,
        missingFile: stats.missing_file,
        errors: stats.errors,
      });
    } catch (e) {
      setBackfillState({
        kind: "fail",
        message: e instanceof Error ? e.message : "Backfill failed",
      });
    }
  };

  // Load settings + status on mount, then poll status every 4s while the
  // panel is mounted. The SSE bus pushes settings changes elsewhere; here
  // a simple poll keeps the connected indicator accurate without extra wiring.
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const [s, st] = await Promise.all([
          centauriApi.getSettings(),
          centauriApi.getStatus(),
        ]);
        if (cancelled) return;
        setSaved(s);
        setStatus(st);
        setPrinterIp(s.printerIp ?? "");
        setPrinterName(s.printerName ?? "");
        setAutoConfirm(s.autoConfirmEnabled);
        setPhase("ready");
      } catch (e) {
        if (cancelled) return;
        setSaveError(
          e instanceof CentauriApiError
            ? e.message
            : e instanceof Error
              ? e.message
              : "Failed to load Centauri settings",
        );
        setPhase("ready");
      }
    };
    void load();
    const t = window.setInterval(async () => {
      try {
        const st = await centauriApi.getStatus();
        if (!cancelled) setStatus(st);
      } catch {
        // status endpoint is best-effort during the poll loop
      }
    }, 4000);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleTest = async () => {
    if (!printerIp.trim()) return;
    setTestState({ kind: "testing" });
    try {
      const r = await centauriApi.testConnection(printerIp.trim());
      if (r.ok) setTestState({ kind: "ok", mainboardId: r.mainboard_id });
      else setTestState({ kind: "fail", message: r.error ?? "Connection failed" });
    } catch (e) {
      setTestState({
        kind: "fail",
        message: e instanceof Error ? e.message : "Test failed",
      });
    }
  };

  const handleDiscover = async () => {
    setDiscoverState({ kind: "scanning" });
    try {
      const results = await centauriApi.discover();
      setDiscoverState({ kind: "done", results });
    } catch (e) {
      setDiscoverState({
        kind: "fail",
        message: e instanceof Error ? e.message : "Discovery failed",
      });
    }
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      const s = await centauriApi.saveSettings({
        printerIp: printerIp.trim() || null,
        printerName: printerName.trim() || null,
        autoConfirmEnabled: autoConfirm,
      });
      setSaved(s);
      setTestState({ kind: "idle" });
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const inputCls =
    "w-full font-mono px-3 py-2.5 bg-surface border border-border rounded-lg text-[13px] text-fg outline-none focus:border-accent focus:ring-[3px] focus:ring-accent/15 transition-all placeholder:text-fg-3";
  const labelCls = "block text-[12.5px] font-medium text-fg-2 mb-1.5";
  const primaryBtnCls =
    "inline-flex items-center gap-2 px-3.5 py-2 rounded-lg bg-accent text-accent-fg text-[13px] font-semibold hover:brightness-105 transition-all disabled:opacity-50 disabled:cursor-not-allowed";
  const secondaryBtnCls =
    "inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-border bg-surface hover:bg-surface-2 text-[13px] text-fg-2 transition-colors disabled:opacity-50";

  if (phase === "loading") {
    return (
      <div className="text-[13px] text-fg-3 inline-flex items-center gap-2">
        <Loader2 size={14} className="animate-spin" /> Loading Centauri
        settings…
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <form onSubmit={handleSave} className="space-y-3 max-w-[560px]">
        <div>
          <label htmlFor="centauri-ip" className={labelCls}>
            Printer LAN address
          </label>
          <input
            id="centauri-ip"
            type="text"
            inputMode="numeric"
            placeholder="192.168.1.50"
            value={printerIp}
            onChange={(e) => {
              setPrinterIp(e.target.value);
              setTestState({ kind: "idle" });
            }}
            className={inputCls}
          />
          <p className="text-[12px] text-fg-3 mt-1">
            IPv4 address. Discovery via UDP broadcast — works on a flat LAN,
            fails over VLANs / WiFi isolation.
          </p>
        </div>

        <div>
          <label htmlFor="centauri-name" className={labelCls}>
            Friendly name{" "}
            <span className="font-normal text-fg-3">(optional)</span>
          </label>
          <input
            id="centauri-name"
            type="text"
            placeholder="Centauri Carbon"
            value={printerName}
            onChange={(e) => setPrinterName(e.target.value)}
            className={`${inputCls} font-sans`}
          />
        </div>

        <label className="inline-flex items-center gap-2.5 text-[13px] text-fg cursor-pointer select-none">
          <input
            type="checkbox"
            checked={autoConfirm}
            onChange={(e) => setAutoConfirm(e.target.checked)}
            className="w-4 h-4 accent-accent"
          />
          Auto-confirm high-confidence matches
          <span className="text-fg-3 text-[12px]">
            (Phase 2 — currently no-op)
          </span>
        </label>

        <div className="flex items-center gap-2 flex-wrap pt-1">
          <button type="submit" disabled={saving} className={primaryBtnCls}>
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
            disabled={!printerIp.trim() || testState.kind === "testing"}
            className={secondaryBtnCls}
          >
            {testState.kind === "testing" ? (
              <>
                <Loader2 size={13} className="animate-spin" /> Testing…
              </>
            ) : (
              "Test connection"
            )}
          </button>
          <button
            type="button"
            onClick={() => void handleDiscover()}
            disabled={discoverState.kind === "scanning"}
            className={secondaryBtnCls}
          >
            {discoverState.kind === "scanning" ? (
              <>
                <Loader2 size={13} className="animate-spin" /> Scanning…
              </>
            ) : (
              <>
                <Radio size={13} /> Discover on LAN
              </>
            )}
          </button>

          {testState.kind === "ok" && (
            <span className="inline-flex items-center gap-1.5 text-[12px] text-success font-medium">
              <Check size={13} /> Reachable
              {testState.mainboardId
                ? ` · MB ${testState.mainboardId.slice(0, 8)}…`
                : ""}
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

      {/* Discovery results */}
      {discoverState.kind === "done" && discoverState.results.length > 0 && (
        <div className="pt-3 border-t border-border-soft max-w-[560px]">
          <div className="text-[12.5px] font-medium text-fg-2 mb-2">
            Found {discoverState.results.length} printer
            {discoverState.results.length === 1 ? "" : "s"} on the network:
          </div>
          <ul className="space-y-1.5">
            {discoverState.results.map((p) => (
              <li
                key={p.host}
                className="flex items-center gap-3 px-3 py-2 bg-surface border border-border-soft rounded-lg text-[13px]"
              >
                <Printer size={14} className="text-fg-3 flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-fg font-medium truncate">
                    {p.name || p.machineName || "Centauri"}
                  </div>
                  <div className="text-[11.5px] font-mono text-fg-3 truncate">
                    {p.host}
                    {p.firmwareVersion ? ` · fw ${p.firmwareVersion}` : ""}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setPrinterIp(p.host);
                    if (p.name && !printerName.trim()) setPrinterName(p.name);
                    setDiscoverState({ kind: "idle" });
                    setTestState({ kind: "idle" });
                  }}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-border bg-bg-3 hover:bg-surface-2 text-[12px] text-fg-2 transition-colors flex-shrink-0"
                >
                  Use
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {discoverState.kind === "done" && discoverState.results.length === 0 && (
        <div className="text-[12.5px] text-fg-3 pt-3 border-t border-border-soft max-w-[560px]">
          No printers responded to the broadcast. If the printer is on the
          same network, fall back to typing the IP manually.
        </div>
      )}
      {discoverState.kind === "fail" && (
        <div className="text-[12.5px] text-danger pt-3 border-t border-border-soft max-w-[560px]">
          {discoverState.message}
        </div>
      )}

      {/* Live connection indicator.
          Three states:
            - connected → green
            - connecting (no error, IP configured) → amber, "Connecting…"
            - disconnected (error present)         → red, error text
          The connecting state covers the brief reconnect gap after save. */}
      {status && saved?.printerIp && (() => {
        const isConnecting = !status.connected && !status.lastError;
        const dotCls = status.connected
          ? "bg-success"
          : isConnecting
            ? "bg-accent"
            : "bg-danger";
        const label = status.connected
          ? "Connected"
          : isConnecting
            ? "Connecting…"
            : "Disconnected";
        return (
          <div className="pt-3 border-t border-border-soft">
            <div className="flex items-center gap-2 text-[12.5px] text-fg-2">
              <span className={`w-2 h-2 rounded-full ${dotCls}`} aria-hidden />
              <span className="font-medium">{label}</span>
              {status.mainboardId && (
                <span className="text-fg-3 font-mono">
                  · MB {status.mainboardId.slice(0, 8)}…
                </span>
              )}
              {status.currentFilename && status.currentStatusCode === 13 && (
                <span className="text-fg-3">
                  · printing{" "}
                  <span className="text-fg">{status.currentFilename}</span>
                  {status.currentProgress != null ? ` (${status.currentProgress}%)` : ""}
                </span>
              )}
              {!status.connected && status.lastError && (
                <span className="text-danger ml-1">· {status.lastError}</span>
              )}
            </div>
          </div>
        );
      })()}

      {/* Phase-4.x: one-shot MD5 backfill so source_hash matcher fires
          against existing models. Idempotent; safe to re-run. */}
      <div className="pt-3 border-t border-border-soft">
        <div className="flex items-start gap-3 flex-wrap">
          <div className="flex-1 min-w-0">
            <h4 className="m-0 text-[13px] font-semibold text-fg">
              Source-hash matching for existing models
            </h4>
            <p className="m-0 mt-1 text-[12px] text-fg-3 max-w-[480px]">
              Compute MD5s for every model in your library so the
              Centauri source-hash signal can match against them. Run
              once after upgrading; idempotent on subsequent runs.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void handleBackfill()}
            disabled={backfillState.kind === "running"}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-border bg-surface hover:bg-surface-2 text-[12.5px] text-fg-2 transition-colors disabled:opacity-50"
          >
            {backfillState.kind === "running" ? (
              <>
                <Loader2 size={13} className="animate-spin" /> Hashing…
              </>
            ) : (
              <>
                <Database size={13} /> Backfill hashes
              </>
            )}
          </button>
        </div>
        {backfillState.kind === "done" && (
          <p className="mt-2 text-[12px] text-fg-3 inline-flex items-center gap-1.5">
            <Check size={12} className="text-success" />
            Hashed {backfillState.processed} new
            {backfillState.skippedExisting > 0 && (
              <> · {backfillState.skippedExisting} already hashed</>
            )}
            {backfillState.missingFile > 0 && (
              <> · {backfillState.missingFile} missing on disk</>
            )}
            {backfillState.errors > 0 && (
              <>
                {" · "}
                <span className="text-warning">
                  {backfillState.errors} error{backfillState.errors === 1 ? "" : "s"}
                </span>
              </>
            )}
          </p>
        )}
        {backfillState.kind === "fail" && (
          <p className="mt-2 text-[12px] text-danger inline-flex items-center gap-1.5">
            <CircleAlert size={12} /> {backfillState.message}
          </p>
        )}
      </div>
    </div>
  );
};

export default CentauriSettings;
