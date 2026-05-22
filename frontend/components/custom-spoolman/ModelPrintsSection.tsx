import React, { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  CircleSlash,
  ExternalLink,
  Loader2,
  Play,
  Plus,
  RefreshCw,
  Trash2,
  XCircle,
} from "lucide-react";
import type { STLModel } from "../../types";
import { printsApi, type Print, type SyncResult } from "../../services/custom-prints";
import {
  spoolmanApi,
  type SpoolmanSettings,
} from "../../services/custom-spoolman";
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

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [s, list] = await Promise.all([
        spoolmanApi.getSettings(),
        printsApi.listForModel(model.id),
      ]);
      setSettings(s);
      setPrints(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load prints");
    } finally {
      setLoading(false);
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
              href={`${settings.baseUrl.replace(/\/api\/v1\/?$/, "")}/spool/show/${toast.spoolId}`}
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
  const displayDuration = print.actDurationMin ?? print.estDurationMin ?? null;
  const isUnsynced = print.status === "completed" && !print.syncedToSpoolman;

  const statusLabel: { icon: React.ReactNode; text: string; tone: string } = (() => {
    if (print.status === "printing") {
      return {
        icon: <Loader2 size={12} className="animate-spin" />,
        text: "Printing",
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
      ? `started ${formatDate(print.startedAt ?? print.createdAt)}`
      : formatDate(print.completedAt ?? print.startedAt ?? print.createdAt);

  return (
    <li className="bg-surface border border-border-soft rounded-lg px-3 py-2.5 flex flex-col gap-1.5">
      <div className="flex items-center gap-2 text-[12px]">
        <span className={`inline-flex items-center gap-1 font-medium ${statusLabel.tone}`}>
          {statusLabel.icon} {statusLabel.text}
        </span>
        <span className="text-fg-3">•</span>
        <span className="text-fg-3">{when}</span>
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
  const f = print.filaments[0];
  const consumed = f?.usedWeightG ?? null;
  const cancelBtnRef = React.useRef<HTMLButtonElement>(null);

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
        className="bg-surface border border-danger/30 rounded-xl shadow-drawer p-5 max-w-[420px] w-full"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex flex-col items-center text-center gap-3">
          <div className="w-12 h-12 rounded-full bg-danger/15 grid place-items-center">
            <AlertTriangle size={22} className="text-danger" />
          </div>
          <h3 id="delete-print-title" className="font-semibold text-fg m-0">
            Delete this print?
          </h3>
          {print.syncedToSpoolman && consumed != null ? (
            <p className="text-[13px] text-fg-2 m-0 leading-relaxed">
              Deleting this won't reverse the{" "}
              <strong className="text-fg">{consumed}g</strong> deducted from spool{" "}
              <strong className="text-fg">#{f?.spoolId}</strong> in Spoolman.
              Adjust it manually over there if needed.
            </p>
          ) : (
            <p className="text-[13px] text-fg-2 m-0">
              This print row will be removed from STLVault.
            </p>
          )}

          {spoolmanBaseUrl && f && print.syncedToSpoolman && (
            <a
              href={`${spoolmanBaseUrl.replace(/\/api\/v1\/?$/, "")}/spool/show/${f.spoolId}`}
              target="_blank"
              rel="noreferrer noopener"
              className="text-[12.5px] text-accent hover:underline inline-flex items-center gap-1"
            >
              Open spool in Spoolman <ExternalLink size={11} />
            </a>
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
