import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  CircleSlash,
  Download,
  ExternalLink,
  Loader2,
  Play,
  Plus,
  Printer,
  RefreshCw,
  Trash2,
  XCircle,
} from "lucide-react";
import type { STLModel } from "../../types";
import { printsApi, type Print, type SyncResult } from "../../services/custom-prints";
import {
  spoolmanApi,
  spoolmanWebUrl,
  type SpoolmanSettings,
} from "../../services/custom-spoolman";
import { centauriApi } from "../../services/custom-centauri";
import LogPrintDialog, { type DialogMode } from "./LogPrintDialog";

interface Props {
  model: STLModel;
}

const formatMinutes = (m: number | null): string => {
  if (m == null) return "";
  const h = Math.floor(m / 60);
  const r = m % 60;
  return h > 0 ? `${h}h ${r}m` : `${r}m`;
};

const formatDate = (ms: number | null): string => {
  if (!ms) return "—";
  try {
    return new Date(ms).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "—";
  }
};

const ModelPrintsSection: React.FC<Props> = ({ model }) => {
  const [settings, setSettings] = useState<SpoolmanSettings | null>(null);
  const [prints, setPrints] = useState<Print[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [dialog, setDialog] = useState<
    | { open: false }
    | { open: true; mode: DialogMode; existingPrint?: Print }
  >({ open: false });

  const [busyPrintId, setBusyPrintId] = useState<string | null>(null);
  const [toast, setToast] = useState<{
    kind: "ok" | "warn";
    text: string;
    spoolId?: number;
  } | null>(null);

  // Confirmation modal state for deletes — must be inline since
  // window.confirm doesn't let us include a hyperlink.
  const [deleteTarget, setDeleteTarget] = useState<Print | null>(null);

  // Request-seq guard: switching models in DetailPanel mid-fetch must
  // not land the old model's prints into the new model's panel.
  const requestSeqRef = useRef(0);

  const loadAll = useCallback(async () => {
    const mySeq = ++requestSeqRef.current;
    setLoading(true);
    setError(null);
    try {
      const [s, list] = await Promise.all([
        spoolmanApi.getSettings(),
        printsApi.listForModel(model.id),
      ]);
      if (mySeq !== requestSeqRef.current) return;
      setSettings(s);
      setPrints(list);
    } catch (e) {
      if (mySeq !== requestSeqRef.current) return;
      setError(e instanceof Error ? e.message : "Failed to load prints");
    } finally {
      if (mySeq === requestSeqRef.current) setLoading(false);
    }
  }, [model.id]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const enabled = !!settings?.enabled && !!settings?.baseUrl;

  const handleSaved = (print: Print, sync: SyncResult) => {
    setDialog({ open: false });
    void loadAll();
    if (sync.synced) {
      const upd = sync.spoolUpdates[0];
      setToast({
        kind: "ok",
        text:
          upd?.remainingWeight != null
            ? `Logged. Spool now at ${Math.round(upd.remainingWeight)}g.`
            : "Print logged and deducted in Spoolman.",
        spoolId: upd?.spoolId,
      });
    } else if (print.status === "completed") {
      setToast({
        kind: "warn",
        text:
          sync.error ??
          "Logged locally. Spoolman didn't accept the consumption.",
        spoolId: sync.failedSpoolId ?? undefined,
      });
    } else {
      setToast({ kind: "ok", text: "Print logged." });
    }
  };

  const handleResync = async (p: Print) => {
    setBusyPrintId(p.id);
    setToast(null);
    try {
      const r = await printsApi.resync(p.id);
      void loadAll();
      const upd = r.sync.spoolUpdates[0];
      if (r.sync.synced) {
        setToast({
          kind: "ok",
          text:
            upd?.remainingWeight != null
              ? `Resync ok. Spool now at ${Math.round(upd.remainingWeight)}g.`
              : "Resync ok.",
        });
      } else {
        setToast({
          kind: "warn",
          text: r.sync.error ?? "Resync failed.",
        });
      }
    } catch (e) {
      setToast({
        kind: "warn",
        text: e instanceof Error ? e.message : "Resync failed",
      });
    } finally {
      setBusyPrintId(null);
    }
  };

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return;
    const target = deleteTarget;
    setBusyPrintId(target.id);
    try {
      await printsApi.delete(target.id);
      setToast({
        kind: "ok",
        text: target.syncedToSpoolman
          ? "Print deleted. Spoolman spool was NOT adjusted."
          : "Print deleted.",
      });
      void loadAll();
    } catch (e) {
      setToast({
        kind: "warn",
        text: e instanceof Error ? e.message : "Delete failed",
      });
    } finally {
      setBusyPrintId(null);
      setDeleteTarget(null);
    }
  };

  if (!enabled) {
    return (
      <section className="flex flex-col gap-2">
        <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-fg-3">
          Prints
        </span>
        <p className="text-[12.5px] text-fg-3">
          Configure Spoolman in <span className="font-medium text-fg-2">Settings</span>{" "}
          to log prints against real spools.
        </p>
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-2.5">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-fg-3">
          Prints
        </span>
        <button
          type="button"
          onClick={() => void loadAll()}
          className="inline-flex items-center gap-1 text-[11.5px] text-fg-3 hover:text-fg"
          title="Refresh"
        >
          <RefreshCw size={11} className={loading ? "animate-spin" : ""} />
        </button>
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setDialog({ open: true, mode: "log" })}
          className="flex-1 inline-flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-accent text-accent-fg text-[13px] font-semibold hover:brightness-105 transition-all"
        >
          <Plus size={14} /> Log a print
        </button>
        <button
          type="button"
          onClick={() => setDialog({ open: true, mode: "start" })}
          className="inline-flex items-center justify-center gap-2 px-3 py-2 rounded-lg border border-border bg-surface hover:bg-surface-2 text-[13px] font-medium text-fg-2 hover:text-fg"
        >
          <Play size={13} /> Start a print
        </button>
      </div>

      {toast && (
        <div
          className={`px-3 py-2 rounded-lg text-[12.5px] flex items-start gap-2 ${
            toast.kind === "ok"
              ? "bg-success/10 border border-success/30 text-success"
              : "bg-warning/10 border border-warning/30 text-warning"
          }`}
        >
          {toast.kind === "ok" ? (
            <CheckCircle2 size={14} className="mt-0.5 flex-shrink-0" />
          ) : (
            <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />
          )}
          <span className="flex-1">{toast.text}</span>
          {settings?.baseUrl && toast.spoolId != null && (
            <a
              href={`${spoolmanWebUrl(settings.baseUrl)}/spool/show/${toast.spoolId}`}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex items-center gap-1 underline-offset-2 hover:underline"
            >
              Open in Spoolman <ExternalLink size={11} />
            </a>
          )}
          <button
            type="button"
            onClick={() => setToast(null)}
            className="opacity-60 hover:opacity-100"
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      )}

      {error && (
        <div className="px-3 py-2 bg-danger/10 border border-danger/30 rounded-lg text-[12.5px] text-danger">
          {error}
        </div>
      )}

      {loading && prints == null && (
        <div className="text-[12.5px] text-fg-3 inline-flex items-center gap-2 px-1">
          <Loader2 size={12} className="animate-spin" /> Loading…
        </div>
      )}

      {prints && prints.length === 0 && !loading && (
        <p className="text-[12.5px] text-fg-3 px-1">
          No prints logged for this model yet.
        </p>
      )}

      {prints && prints.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {prints.map((p) => (
            <PrintRow
              key={p.id}
              print={p}
              busy={busyPrintId === p.id}
              spoolmanBaseUrl={settings?.baseUrl ?? null}
              onResync={() => void handleResync(p)}
              onComplete={() =>
                setDialog({ open: true, mode: "complete", existingPrint: p })
              }
              onDelete={() => setDeleteTarget(p)}
            />
          ))}
        </ul>
      )}

      {dialog.open && (
        <LogPrintDialog
          open
          mode={dialog.mode}
          model={model}
          existingPrint={dialog.existingPrint}
          spoolmanBaseUrl={settings?.baseUrl ?? null}
          onClose={() => setDialog({ open: false })}
          onSaved={handleSaved}
        />
      )}

      {deleteTarget && (
        <DeleteConfirm
          print={deleteTarget}
          spoolmanBaseUrl={settings?.baseUrl ?? null}
          busy={busyPrintId === deleteTarget.id}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => void handleConfirmDelete()}
        />
      )}
    </section>
  );
};

// --- print row ---

const PrintRow: React.FC<{
  print: Print;
  busy: boolean;
  spoolmanBaseUrl: string | null;
  onResync: () => void;
  onComplete: () => void;
  onDelete: () => void;
}> = ({ print, busy, spoolmanBaseUrl, onResync, onComplete, onDelete }) => {
  const f = print.filaments[0];
  const displayWeight = f?.usedWeightG ?? f?.estWeightG ?? null;
  // Prefer the user's observed wall-clock; fall back to the slicer's
  // active-extrusion estimate. Different physical quantities — see
  // repo.rollup_window docs.
  const displayDuration = print.wallClockMin ?? print.estDurationMin ?? null;
  const isUnsynced = print.status === "completed" && !print.syncedToSpoolman;

  // "printing" status doesn't mean a printer is observably running —
  // it means "user clicked Start and hasn't reported an outcome yet."
  // After 24h that's almost certainly a forgotten one, so we flag it
  // as stale rather than continuing to imply something live.
  const startedMs = print.startedAt ?? print.createdAt;
  const isStalePrinting =
    print.status === "printing" &&
    startedMs != null &&
    Date.now() - startedMs > 24 * 60 * 60 * 1000;

  const statusLabel: { icon: React.ReactNode; text: string; tone: string } = (() => {
    if (print.status === "printing") {
      return isStalePrinting
        ? {
            icon: <AlertTriangle size={12} />,
            text: "Started — awaiting outcome",
            tone: "text-warning",
          }
        : {
            icon: <Play size={12} />,
            text: "Started",
            tone: "text-accent",
          };
    }
    if (print.status === "completed") {
      return isUnsynced
        ? {
            icon: <AlertTriangle size={12} />,
            text: "Logged, not synced",
            tone: "text-warning",
          }
        : { icon: <Check size={12} />, text: "Completed", tone: "text-success" };
    }
    if (print.status === "failed") {
      return { icon: <XCircle size={12} />, text: "Failed", tone: "text-danger" };
    }
    return { icon: <CircleSlash size={12} />, text: "Cancelled", tone: "text-fg-3" };
  })();

  const when =
    print.status === "printing"
      ? `started ${formatDate(startedMs)}`
      : formatDate(print.completedAt ?? print.startedAt ?? print.createdAt);

  const isCentauri = print.source === "centauri";

  return (
    <li className="bg-surface border border-border-soft rounded-lg px-3 py-2.5 flex flex-col gap-1.5">
      <div className="flex items-center gap-2 text-[12px] flex-wrap">
        <span className={`inline-flex items-center gap-1 font-medium ${statusLabel.tone}`}>
          {statusLabel.icon} {statusLabel.text}
        </span>
        <span className="text-fg-3">•</span>
        <span className="text-fg-3">{when}</span>
        {isCentauri && (
          <span
            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-pill bg-accent/15 text-accent text-[10.5px] font-medium"
            title="Logged automatically from the Centauri Carbon's job history"
          >
            <Printer size={10} /> From Centauri
          </span>
        )}
      </div>

      <div className="flex items-center gap-2 text-[12.5px]">
        {f?.filamentColor && (
          <span
            aria-hidden
            className="w-3 h-3 rounded-full border border-border-soft flex-shrink-0"
            style={{ backgroundColor: `#${f.filamentColor}` }}
          />
        )}
        <span className="text-fg flex-1 min-w-0 truncate">
          {f?.spoolLabel ?? `Spool #${f?.spoolId ?? "?"}`}
        </span>
        <span className="font-mono text-fg-2 flex-shrink-0">
          {displayWeight != null ? `${displayWeight}g` : "—"}
        </span>
        {displayDuration != null && (
          <>
            <span className="text-fg-3">•</span>
            <span className="font-mono text-fg-2">
              {formatMinutes(displayDuration)}
            </span>
          </>
        )}
      </div>

      {print.notes && (
        <p className="text-[12px] text-fg-3 italic m-0 break-words">
          "{print.notes}"
        </p>
      )}

      <div className="flex items-center gap-1.5 mt-0.5">
        {print.status === "printing" && (
          <button
            type="button"
            onClick={onComplete}
            disabled={busy}
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded text-[11.5px] bg-accent/15 hover:bg-accent/25 text-accent font-medium transition-colors disabled:opacity-50"
          >
            <Check size={11} /> Complete
          </button>
        )}
        {isUnsynced && (
          <button
            type="button"
            onClick={onResync}
            disabled={busy}
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded text-[11.5px] bg-warning/15 hover:bg-warning/25 text-warning font-medium transition-colors disabled:opacity-50"
          >
            <RefreshCw size={11} className={busy ? "animate-spin" : ""} /> Retry sync
          </button>
        )}
        {spoolmanBaseUrl && f && (
          <a
            href={`${spoolmanBaseUrl.replace(/\/api\/v1\/?$/, "")}/spool/show/${f.spoolId}`}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex items-center gap-1 text-[11.5px] text-fg-3 hover:text-fg"
          >
            Spool <ExternalLink size={10} />
          </a>
        )}
        {isCentauri && print.centauriEventId != null && (
          <a
            href={centauriApi.gcodeUrl(print.centauriEventId)}
            download
            className="inline-flex items-center gap-1 text-[11.5px] text-fg-3 hover:text-fg"
            title="Download the .gcode the printer ran for this job"
          >
            View source .gcode <Download size={10} />
          </a>
        )}
        <div className="flex-1" />
        <button
          type="button"
          onClick={onDelete}
          disabled={busy}
          className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11.5px] text-fg-3 hover:text-danger hover:bg-danger/10 transition-colors"
          aria-label="Delete print"
        >
          <Trash2 size={11} />
        </button>
      </div>
    </li>
  );
};

// --- delete confirmation with the Spoolman caveat ---

const DeleteConfirm: React.FC<{
  print: Print;
  spoolmanBaseUrl: string | null;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}> = ({ print, spoolmanBaseUrl, busy, onCancel, onConfirm }) => {
  const cancelBtnRef = React.useRef<HTMLButtonElement>(null);

  // Every filament leg that actually got deducted (consumedAt is set)
  // is something Spoolman won't reverse. Enumerate ALL of them — a
  // multi-spool print otherwise hides legs from the user.
  const consumedLegs = print.filaments.filter(
    (f) => f.consumedAt != null && f.usedWeightG != null,
  );
  const stripApiSuffix = (u: string | null) =>
    u ? u.replace(/\/api\/v1\/?$/, "") : "";

  // a11y: Esc cancels; autofocus the safer (Cancel) button so an
  // accidental Enter doesn't delete.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onCancel();
    };
    window.addEventListener("keydown", onKey);
    const t = window.setTimeout(() => cancelBtnRef.current?.focus(), 50);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.clearTimeout(t);
    };
  }, [busy, onCancel]);

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/60 backdrop-blur-[2px] p-4"
      onClick={onCancel}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="delete-print-title"
        className="bg-surface border border-danger/30 rounded-xl shadow-drawer p-5 max-w-[460px] w-full"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex flex-col items-center text-center gap-3">
          <div className="w-12 h-12 rounded-full bg-danger/15 grid place-items-center">
            <AlertTriangle size={22} className="text-danger" />
          </div>
          <h3 id="delete-print-title" className="font-semibold text-fg m-0">
            Delete this print?
          </h3>
          {consumedLegs.length > 0 ? (
            <div className="w-full">
              <p className="text-[13px] text-fg-2 m-0 leading-relaxed mb-2">
                Deleting this won't reverse the deductions already made in
                Spoolman. Adjust them manually over there if needed:
              </p>
              <ul className="flex flex-col gap-1 text-left">
                {consumedLegs.map((leg) => (
                  <li
                    key={leg.id}
                    className="flex items-center gap-2 px-2.5 py-1.5 bg-bg-3 border border-border-soft rounded-md text-[12.5px]"
                  >
                    {leg.filamentColor && (
                      <span
                        aria-hidden
                        className="w-3 h-3 rounded-full border border-border-soft flex-shrink-0"
                        style={{ backgroundColor: `#${leg.filamentColor}` }}
                      />
                    )}
                    <span className="flex-1 min-w-0 truncate text-fg">
                      {leg.spoolLabel ?? `Spool #${leg.spoolId}`}
                    </span>
                    <span className="font-mono text-fg-2 flex-shrink-0">
                      {leg.usedWeightG}g
                    </span>
                    {spoolmanBaseUrl && (
                      <a
                        href={`${stripApiSuffix(spoolmanBaseUrl)}/spool/show/${leg.spoolId}`}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="text-accent hover:underline inline-flex items-center gap-0.5"
                        title={`Open spool #${leg.spoolId} in Spoolman`}
                      >
                        <ExternalLink size={10} />
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="text-[13px] text-fg-2 m-0">
              This print row will be removed from STLVault.
            </p>
          )}

          <div className="flex items-center gap-2 w-full mt-1">
            <button
              ref={cancelBtnRef}
              type="button"
              onClick={onCancel}
              disabled={busy}
              className="flex-1 px-3 py-2 rounded-lg border border-border bg-bg-3 hover:bg-surface-2 text-[13px] text-fg-2 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onConfirm}
              disabled={busy}
              className="flex-1 inline-flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-danger text-white text-[13px] font-semibold hover:brightness-110 transition-all disabled:opacity-50"
            >
              {busy ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
              Delete print
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ModelPrintsSection;
