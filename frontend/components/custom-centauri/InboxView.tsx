import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  Menu as MenuIcon,
  ChevronLeft,
  Inbox,
  Check,
  X,
  Search,
  Clock,
  AlertTriangle,
  Loader2,
  Printer,
  Bookmark,
  Weight,
  Zap,
  Undo2,
} from "lucide-react";
import {
  centauriApi,
  CentauriApiError,
  MatchCandidate,
  PrintEventWithCandidates,
} from "../../services/custom-centauri";
import { spoolmanApi, type SpoolSummary } from "../../services/custom-spoolman";
import { STLModel } from "../../types";

interface InboxViewProps {
  models: STLModel[];
  onOpenMobileSidebar?: () => void;
  onBack: () => void;
}

const fmtTime = (ms: number | null | undefined): string => {
  if (!ms) return "—";
  const d = new Date(ms * 1000);
  return d.toLocaleString();
};

const fmtDuration = (min: number | null | undefined): string => {
  if (min == null) return "—";
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
};

const outcomeChipCls = (
  outcome: PrintEventWithCandidates["outcome"],
): string => {
  switch (outcome) {
    case "completed":
      return "bg-success/15 text-success";
    case "failed":
      return "bg-danger/15 text-danger";
    case "cancelled":
      return "bg-bg-3 text-fg-2";
  }
};

const InboxView: React.FC<InboxViewProps> = ({
  models,
  onOpenMobileSidebar,
  onBack,
}) => {
  const [events, setEvents] = useState<PrintEventWithCandidates[] | null>(null);
  const [autoMatched, setAutoMatched] = useState<PrintEventWithCandidates[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pickerOpenFor, setPickerOpenFor] = useState<PrintEventWithCandidates | null>(null);
  const [busyIds, setBusyIds] = useState<Set<number>>(new Set());

  const refresh = useCallback(async () => {
    try {
      const [inbox, auto] = await Promise.all([
        centauriApi.listEvents(false),
        centauriApi.listRecentAutoMatched().catch(() => []),
      ]);
      setEvents(inbox);
      setAutoMatched(auto);
      setLoadError(null);
    } catch (e) {
      setLoadError(
        e instanceof CentauriApiError
          ? e.message
          : e instanceof Error
            ? e.message
            : "Failed to load inbox",
      );
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Live updates via SSE — new events, review state changes, and
  // auto-confirms each refresh the visible lists. The auto-matched
  // panel uses the same data source so refresh keeps both in sync.
  useEffect(() => {
    const es = new EventSource(centauriApi.streamUrl());
    es.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data) as { type: string };
        if (
          msg.type === "event.new" ||
          msg.type === "event.reviewed" ||
          msg.type === "event.auto"
        ) {
          void refresh();
        }
      } catch {
        // keepalive comments don't parse as JSON; ignore
      }
    };
    es.onerror = () => {
      // EventSource auto-reconnects with backoff; don't surface
      // transient errors.
    };
    return () => es.close();
  }, [refresh]);

  const setBusy = (id: number, busy: boolean) => {
    setBusyIds((prev) => {
      const next = new Set(prev);
      if (busy) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const handleConfirm = async (
    eventId: number,
    modelId: string,
    spoolId?: number | null,
  ) => {
    setBusy(eventId, true);
    try {
      await centauriApi.review(eventId, "confirm", { modelId, spoolId });
      setPickerOpenFor(null);
      await refresh();
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Confirm failed");
    } finally {
      setBusy(eventId, false);
    }
  };

  const handleDismiss = async (eventId: number) => {
    setBusy(eventId, true);
    try {
      await centauriApi.review(eventId, "dismiss");
      await refresh();
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Dismiss failed");
    } finally {
      setBusy(eventId, false);
    }
  };

  const handleReserve = async (eventId: number) => {
    setBusy(eventId, true);
    try {
      await centauriApi.review(eventId, "reserve");
      await refresh();
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Reserve failed");
    } finally {
      setBusy(eventId, false);
    }
  };

  const handleUndo = async (eventId: number) => {
    setBusy(eventId, true);
    try {
      await centauriApi.undoAuto(eventId);
      await refresh();
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Undo failed");
    } finally {
      setBusy(eventId, false);
    }
  };

  const isEmpty = events !== null && events.length === 0;

  return (
    <div className="flex-1 min-w-0 flex flex-col overflow-hidden bg-bg">
      <header className="px-4 py-3.5 md:px-7 md:py-4 border-b border-border-soft flex items-center gap-3">
        {onOpenMobileSidebar && (
          <button
            type="button"
            onClick={onOpenMobileSidebar}
            className="md:hidden w-9 h-9 grid place-items-center rounded-md text-fg hover:bg-bg-3 transition-colors"
            aria-label="Open sidebar"
          >
            <MenuIcon size={20} />
          </button>
        )}
        <button
          type="button"
          onClick={onBack}
          className="hidden md:inline-flex items-center gap-1.5 px-2 py-1.5 -ml-1 rounded-md text-fg-2 hover:bg-bg-3 hover:text-fg transition-colors text-[13px]"
        >
          <ChevronLeft size={16} />
          Library
        </button>
        <h1 className="text-[16px] md:text-[22px] font-semibold -tracking-[0.02em] text-fg">
          Print Inbox
        </h1>
        {events && events.length > 0 && (
          <span className="font-mono text-[12px] text-fg-2 bg-bg-3 px-2.5 py-1 rounded-pill">
            {events.length} unreviewed
          </span>
        )}
      </header>

      <div className="flex-1 overflow-y-auto">
        <div className="w-full px-4 md:px-7 py-7">
          <div className="mb-6">
            <h2 className="text-[24px] font-semibold -tracking-[0.02em] text-fg m-0">
              Prints from your Centauri
            </h2>
            <p className="text-fg-3 text-[13.5px] mt-1.5 max-w-[640px]">
              Jobs the printer reported as completed, failed, or cancelled.
              Confirm a match to write a print-log entry; dismiss to file the
              event without logging (calibration, test prints, etc.).
            </p>
          </div>

          {loadError && (
            <div className="mb-5 px-3.5 py-2.5 rounded-lg bg-danger-soft border border-danger/40 border-l-[3px] border-l-danger text-[12.5px] text-fg-2">
              <strong className="text-fg font-semibold">Error: </strong>
              {loadError}
            </div>
          )}

          {events === null && !loadError && (
            <div className="text-[13px] text-fg-3 inline-flex items-center gap-2">
              <Loader2 size={14} className="animate-spin" /> Loading inbox…
            </div>
          )}

          {isEmpty && (
            <div className="rounded-[10px] border border-border-soft bg-surface px-6 py-12 text-center">
              <Inbox size={28} className="text-fg-3 mx-auto" />
              <div className="text-[15px] font-medium text-fg mt-3">
                Inbox is empty
              </div>
              <div className="text-[13px] text-fg-3 mt-1 max-w-[480px] mx-auto">
                Once the printer finishes a job, it'll show up here. Make sure
                the printer LAN address is configured under Settings → Centauri
                Carbon and the connection indicator is green.
              </div>
            </div>
          )}

          {events && events.length > 0 && (
            <div className="space-y-3">
              {events.map((ev) => (
                <EventCard
                  key={ev.id}
                  event={ev}
                  busy={busyIds.has(ev.id)}
                  onConfirm={(modelId) => void handleConfirm(ev.id, modelId)}
                  onPickModel={() => setPickerOpenFor(ev)}
                  onDismiss={() => void handleDismiss(ev.id)}
                  onReserve={() => void handleReserve(ev.id)}
                />
              ))}
            </div>
          )}

          {autoMatched.length > 0 && (
            <div className="mt-8">
              <h3 className="text-[14px] font-semibold text-fg-2 m-0 flex items-center gap-2">
                <Zap size={13} className="text-accent" />
                Recently auto-matched
                <span className="text-[11.5px] text-fg-3 font-normal">
                  (undo within 7 days)
                </span>
              </h3>
              <div className="mt-3 space-y-2">
                {autoMatched.map((ev) => (
                  <AutoMatchedRow
                    key={ev.id}
                    event={ev}
                    busy={busyIds.has(ev.id)}
                    onUndo={() => void handleUndo(ev.id)}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {pickerOpenFor && (
        <ModelPicker
          event={pickerOpenFor}
          models={models}
          busy={busyIds.has(pickerOpenFor.id)}
          onCancel={() => setPickerOpenFor(null)}
          onPick={(modelId, spoolId) =>
            void handleConfirm(pickerOpenFor.id, modelId, spoolId)
          }
        />
      )}
    </div>
  );
};

// ---------------------------------------------------------------- EventCard

const confidenceTone = (
  conf: number,
): { dot: string; ring: string; label: string } => {
  if (conf >= 0.7) return { dot: "bg-success", ring: "border-success/40", label: "strong" };
  if (conf >= 0.4) return { dot: "bg-accent", ring: "border-accent/40", label: "weak" };
  return { dot: "bg-danger", ring: "border-danger/40", label: "trace" };
};

const EventCard: React.FC<{
  event: PrintEventWithCandidates;
  busy: boolean;
  onConfirm: (modelId: string) => void;
  onPickModel: () => void;
  onDismiss: () => void;
  onReserve: () => void;
}> = ({ event, busy, onConfirm, onPickModel, onDismiss, onReserve }) => {
  const [thumbErrored, setThumbErrored] = useState(false);
  const candidates = event.candidates ?? [];
  const topCandidate = candidates[0] as MatchCandidate | undefined;
  const isReserved = event.review?.action === "reserve";

  return (
    <article
      className={`rounded-card border bg-surface p-3.5 flex gap-4 ${
        isReserved
          ? "border-accent/40 border-l-[3px] border-l-accent"
          : "border-border-soft"
      }`}
    >
      <div className="w-[120px] h-[120px] flex-shrink-0 rounded-[10px] bg-bg-3 overflow-hidden grid place-items-center">
        {thumbErrored ? (
          <Printer size={28} className="text-fg-3" />
        ) : (
          <img
            src={centauriApi.thumbnailUrl(event.id)}
            alt=""
            className="w-full h-full object-cover"
            onError={() => setThumbErrored(true)}
          />
        )}
      </div>

      <div className="flex-1 min-w-0 flex flex-col gap-2">
        <div className="flex items-start gap-3 flex-wrap">
          <div className="flex-1 min-w-0">
            <h3 className="m-0 text-[14px] font-semibold text-fg truncate">
              {event.gcodeFilename}
            </h3>
            <p className="m-0 mt-0.5 text-[11.5px] text-fg-3 font-mono truncate">
              Job {event.sdcpJobId}
            </p>
          </div>
          <span
            className={`text-[11px] font-mono px-2 py-0.5 rounded-pill ${outcomeChipCls(event.outcome)}`}
          >
            {event.outcome}
          </span>
          {isReserved && (
            <span
              className="inline-flex items-center gap-1 text-[11px] font-mono px-2 py-0.5 rounded-pill bg-accent/15 text-accent"
              title="Reserved — link from the next upload, or pick a model now."
            >
              <Bookmark size={11} /> reserved
            </span>
          )}
        </div>

        <div className="flex gap-2 flex-wrap text-[11.5px] text-fg-2">
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-bg-3">
            <Clock size={11} />
            {event.actTimeMin != null
              ? `${fmtDuration(event.actTimeMin)} actual`
              : `${fmtDuration(event.estTimeMin)} est`}
          </span>
          {event.estFilamentG != null && (
            <span
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-bg-3"
              title="Filament weight estimated by the slicer"
            >
              <Weight size={11} />
              {event.estFilamentG.toFixed(1)}g
            </span>
          )}
          <span className="px-2 py-0.5 rounded bg-bg-3 text-fg-3">
            Started {fmtTime(event.startedAt)}
          </span>
        </div>

        {/* Match suggestions. One chip per candidate — clicking a chip
            confirms that match immediately. The chip's coloured dot
            communicates confidence. When the matcher returns multiple
            hits at the same confidence we render them all so the user
            can pick the right one without opening the search picker. */}
        {candidates.length > 0 && (
          <div className="flex flex-wrap gap-1.5 pt-0.5">
            <span className="text-[11px] text-fg-3 self-center mr-1">
              Suggested:
            </span>
            {candidates.slice(0, 4).map((c) => {
              const tone = confidenceTone(c.confidence);
              return (
                <button
                  key={c.id}
                  type="button"
                  disabled={busy}
                  onClick={() => onConfirm(c.modelId)}
                  title={c.reason ?? undefined}
                  className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-md border ${tone.ring} bg-bg-3 hover:bg-surface-2 text-[12px] text-fg transition-colors disabled:opacity-50`}
                >
                  <span
                    className={`w-1.5 h-1.5 rounded-full ${tone.dot}`}
                    aria-hidden
                  />
                  <span className="truncate max-w-[180px]">
                    {c.modelName ?? "(deleted)"}
                  </span>
                  <span className="text-fg-3 font-mono">
                    {Math.round(c.confidence * 100)}%
                  </span>
                </button>
              );
            })}
            {candidates.length > 4 && (
              <span className="self-center text-[11px] text-fg-3">
                +{candidates.length - 4} more
              </span>
            )}
          </div>
        )}

        <div className="flex gap-2 pt-1 flex-wrap">
          {topCandidate && candidates.length === 1 ? (
            <button
              type="button"
              onClick={() => onConfirm(topCandidate.modelId)}
              disabled={busy}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-accent text-accent-fg text-[12.5px] font-semibold hover:brightness-105 transition-all disabled:opacity-50"
            >
              <Check size={13} /> Confirm match
            </button>
          ) : null}
          <button
            type="button"
            onClick={onPickModel}
            disabled={busy}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[12.5px] transition-colors disabled:opacity-50 ${
              topCandidate && candidates.length === 1
                ? "border border-border bg-surface hover:bg-surface-2 text-fg-2"
                : "bg-accent text-accent-fg font-semibold hover:brightness-105"
            }`}
          >
            <Check size={13} />{" "}
            {candidates.length === 0 ? "Pick model…" : "Pick a different model…"}
          </button>
          {!isReserved && (
            <button
              type="button"
              onClick={onReserve}
              disabled={busy}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-border bg-surface hover:bg-surface-2 text-[12.5px] text-fg-2 transition-colors disabled:opacity-50"
              title="Defer this — link it after you upload the model file."
            >
              <Bookmark size={13} /> Reserve for upload
            </button>
          )}
          <button
            type="button"
            onClick={onDismiss}
            disabled={busy}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-border bg-surface hover:bg-surface-2 text-[12.5px] text-fg-2 transition-colors disabled:opacity-50"
          >
            <X size={13} /> Dismiss
          </button>
          {event.outcome === "failed" && (
            <span className="inline-flex items-center gap-1 text-[11px] text-danger ml-1">
              <AlertTriangle size={11} /> Print errored — log anyway?
            </span>
          )}
        </div>
      </div>
    </article>
  );
};

// ------------------------------------------------------------ ModelPicker

const ModelPicker: React.FC<{
  event: PrintEventWithCandidates;
  models: STLModel[];
  busy: boolean;
  onCancel: () => void;
  onPick: (modelId: string, spoolId: number | null) => void;
}> = ({ event, models, busy, onCancel, onPick }) => {
  const [query, setQuery] = useState("");
  const [spoolId, setSpoolId] = useState<number | null>(null);
  const [spools, setSpools] = useState<SpoolSummary[] | null>(null);
  const [spoolsError, setSpoolsError] = useState<string | null>(null);

  // Spools load lazily — Spoolman might not be configured. Failure is
  // non-fatal: the picker still works, the dropdown is just absent.
  useEffect(() => {
    let cancelled = false;
    spoolmanApi
      .listSpools()
      .then((list) => {
        if (cancelled) return;
        // Hide archived spools and any with zero remaining weight — same
        // shape as LogPrintDialog's reasonable-spool list.
        const visible = list.filter(
          (s) =>
            !s.archived &&
            (s.remainingWeight == null || s.remainingWeight > 0),
        );
        setSpools(visible);
      })
      .catch((e) => {
        if (cancelled) return;
        setSpoolsError(e instanceof Error ? e.message : "Spools unavailable");
        setSpools([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    const base = q
      ? models.filter((m) => m.name.toLowerCase().includes(q))
      : [...models].sort((a, b) => b.dateAdded - a.dateAdded);
    return base.slice(0, 50);
  }, [models, query]);

  // Group spools by material so the dropdown is easier to scan when the
  // user has multiple colours of PLA loaded.
  const spoolsByMaterial = useMemo(() => {
    const groups = new Map<string, SpoolSummary[]>();
    for (const s of spools ?? []) {
      const key = s.material ?? "Other";
      const arr = groups.get(key);
      if (arr) arr.push(s);
      else groups.set(key, [s]);
    }
    return Array.from(groups.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [spools]);

  const showSpoolPicker = spools !== null && spools.length > 0;

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-[70] grid place-items-center bg-black/60 backdrop-blur-[2px] p-4"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-[520px] max-h-[80vh] bg-surface border border-border rounded-xl shadow-drawer overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-3.5 border-b border-border-soft flex items-center gap-2">
          <h3 className="m-0 text-[14px] font-semibold text-fg flex-1 truncate">
            Match{" "}
            <span className="font-mono text-[12.5px] text-fg-2">
              {event.gcodeFilename}
            </span>{" "}
            to…
          </h3>
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="w-7 h-7 grid place-items-center rounded-md text-fg-3 hover:bg-bg-3 hover:text-fg transition-colors disabled:opacity-50"
            aria-label="Cancel"
          >
            <X size={16} />
          </button>
        </div>

        <div className="px-5 py-3 border-b border-border-soft flex flex-col gap-2.5">
          <div className="relative">
            <Search
              size={14}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-fg-3"
            />
            <input
              autoFocus
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by name…"
              className="w-full bg-bg-3 border border-border-soft rounded-md pl-9 pr-3 py-2 text-[13px] text-fg outline-none focus:border-accent transition-colors placeholder:text-fg-3"
            />
          </div>

          {showSpoolPicker && (
            <label className="flex items-center gap-2 text-[12px] text-fg-3">
              <span className="flex-shrink-0">Spool (optional):</span>
              <select
                value={spoolId ?? ""}
                onChange={(e) =>
                  setSpoolId(e.target.value ? Number(e.target.value) : null)
                }
                disabled={busy}
                className="flex-1 min-w-0 bg-bg-3 border border-border-soft rounded-md px-2 py-1.5 text-[12.5px] text-fg outline-none focus:border-accent transition-colors disabled:opacity-50"
              >
                <option value="">— None (log without spool) —</option>
                {spoolsByMaterial.map(([material, list]) => (
                  <optgroup key={material} label={material}>
                    {list.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.label}
                        {s.remainingWeight != null
                          ? ` — ${Math.round(s.remainingWeight)}g left`
                          : ""}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </label>
          )}
          {spoolsError && (
            <p className="text-[11.5px] text-fg-3 m-0">
              Spools unavailable — pick a model below to log without one.
            </p>
          )}
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto">
          {matches.length === 0 && (
            <div className="px-5 py-8 text-center text-[13px] text-fg-3">
              No models match — try a different search, or dismiss this event
              if it was a test print.
            </div>
          )}
          <ul>
            {matches.map((m) => (
              <li key={m.id}>
                <button
                  type="button"
                  onClick={() => onPick(m.id, spoolId)}
                  disabled={busy}
                  className="w-full px-5 py-2.5 flex items-center gap-3 text-left hover:bg-bg-3 transition-colors disabled:opacity-50"
                >
                  <div className="w-9 h-9 rounded-md bg-bg-3 grid place-items-center text-fg-3 flex-shrink-0 overflow-hidden">
                    {m.thumbnail ? (
                      <img
                        src={m.thumbnail}
                        alt=""
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <Printer size={14} />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-[13px] text-fg truncate">{m.name}</div>
                    <div className="text-[11.5px] text-fg-3">
                      {new Date(m.dateAdded).toLocaleDateString()}
                    </div>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
};

// ---------------------------------------------------- AutoMatchedRow
// Compact row for the inbox's "Recently auto-matched" panel. Shows the
// model the ingest path linked the print to, with an Undo button while
// inside the 24-hour window. Past the window the backend returns 410,
// but the panel itself filters by `autoMatchedAt >= now - 24h` server-
// side, so the user shouldn't see a row that can't be undone.

// 7-day undo window — matches the backend's UNDO_WINDOW_SECONDS in
// custom_routes/centauri.py. Keep these in sync if either side changes.
const UNDO_WINDOW_MS = 7 * 24 * 3600 * 1000;

const fmtUndoLeft = (autoMatchedAt: number | undefined): string => {
  if (!autoMatchedAt) return "—";
  const expiry = autoMatchedAt * 1000 + UNDO_WINDOW_MS;
  const msLeft = expiry - Date.now();
  if (msLeft <= 0) return "0m left";
  const days = Math.floor(msLeft / 86_400_000);
  const hours = Math.floor((msLeft % 86_400_000) / 3_600_000);
  if (days >= 1) {
    // Show "Nd Mh" for the first six days, drop the hours on the
    // last day so the chip stays compact.
    return hours > 0 ? `${days}d ${hours}h left` : `${days}d left`;
  }
  if (hours >= 1) return `${hours}h left`;
  const minutes = Math.max(1, Math.floor(msLeft / 60_000));
  return `${minutes}m left`;
};

const AutoMatchedRow: React.FC<{
  event: PrintEventWithCandidates;
  busy: boolean;
  onUndo: () => void;
}> = ({ event, busy, onUndo }) => {
  const [thumbErrored, setThumbErrored] = useState(false);
  const candidate = (event.candidates ?? []).find(
    (c) => c.modelId === event.resultingModelId,
  );
  const modelName = candidate?.modelName ?? "(deleted model)";
  return (
    <article className="rounded-card border border-border-soft bg-surface px-3 py-2 flex items-center gap-3">
      <div className="w-10 h-10 flex-shrink-0 rounded-md bg-bg-3 overflow-hidden grid place-items-center">
        {thumbErrored ? (
          <Printer size={14} className="text-fg-3" />
        ) : (
          <img
            src={centauriApi.thumbnailUrl(event.id)}
            alt=""
            className="w-full h-full object-cover"
            onError={() => setThumbErrored(true)}
          />
        )}
      </div>
      <div className="flex-1 min-w-0 flex items-center gap-2 flex-wrap">
        <span className="text-[12.5px] text-fg truncate font-medium">
          {modelName}
        </span>
        <span className="text-[11px] text-fg-3 font-mono truncate">
          {event.gcodeFilename}
        </span>
        {event.estFilamentG != null && (
          <span className="text-[11px] text-fg-3 inline-flex items-center gap-1">
            <Weight size={10} />
            {event.estFilamentG.toFixed(1)}g
          </span>
        )}
      </div>
      <span className="text-[11px] text-fg-3 font-mono whitespace-nowrap">
        {fmtUndoLeft(event.autoMatchedAt)}
      </span>
      <button
        type="button"
        onClick={onUndo}
        disabled={busy}
        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md border border-border bg-surface hover:bg-surface-2 text-[12px] text-fg-2 transition-colors disabled:opacity-50"
      >
        <Undo2 size={12} />
        Undo
      </button>
    </article>
  );
};

export default InboxView;
