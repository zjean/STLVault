// Fork-only — surfaced after an upload completes when one or more
// Centauri print events are sitting in the "reserved for upload" state.
// Lets the user link any reserve to one of the just-uploaded models in a
// single dialog instead of re-finding the inbox card.
//
// Auto-tick heuristic: if a reserve's filename-signal candidates already
// point at a just-uploaded model (the matcher picked it up on event
// ingestion, before the model existed; or — more typically — the user
// uploads a file whose normalised stem matches the reserve's gcodeFilename),
// pre-tick the row + pre-select that model. v1 only re-runs filename
// normalisation client-side; source-hash auto-tick lands once the MD5
// backfill PR follows this one.

import React, { useMemo, useState } from "react";
import { Bookmark, Check, X, Printer, Loader2 } from "lucide-react";
import {
  centauriApi,
  CentauriApiError,
  PrintEventWithCandidates,
} from "../../services/custom-centauri";
import { STLModel } from "../../types";

interface Props {
  uploadedModels: STLModel[];
  reserves: PrintEventWithCandidates[];
  onClose: () => void;
  onLinked: () => void;
}

// Match the backend's matcher.normalise_filename_stem regex spec. Kept in
// sync via the matcher unit tests; the design is single-pass on purpose
// so callers shouldn't loop.
const VERSION_SUFFIXES = [
  /[-_]v\d+(\.\d+)?$/,
  /[-_]\d+$/,
  /[-_]?\([^)]*\)$/,
];

function normaliseStem(name: string): string {
  let s = name.trim().toLowerCase();
  s = s.replace(/\.(stl|3mf)$/i, "");
  let best: { len: number; out: string } | null = null;
  for (const rx of VERSION_SUFFIXES) {
    const m = rx.exec(s);
    if (m && (!best || m[0].length > best.len)) {
      best = { len: m[0].length, out: s.slice(0, m.index) };
    }
  }
  if (best) s = best.out;
  return s.replace(/[\s_]+/g, "_").replace(/^_+|_+$/g, "");
}

const fmtTime = (epochSec: number | null | undefined): string => {
  if (!epochSec) return "—";
  return new Date(epochSec * 1000).toLocaleString();
};

const PostUploadLinkDialog: React.FC<Props> = ({
  uploadedModels,
  reserves,
  onClose,
  onLinked,
}) => {
  // Default selections: auto-tick a reserve when its normalised
  // gcodeFilename matches one of the just-uploaded models. Pre-select
  // that model in the dropdown.
  const defaultState = useMemo(() => {
    const checked: Record<number, boolean> = {};
    const modelByReserve: Record<number, string> = {};
    for (const ev of reserves) {
      const evStem = normaliseStem(ev.gcodeFilename);
      const hit = uploadedModels.find(
        (m) => normaliseStem(m.name) === evStem,
      );
      if (hit) {
        checked[ev.id] = true;
        modelByReserve[ev.id] = hit.id;
      } else {
        checked[ev.id] = false;
        modelByReserve[ev.id] = uploadedModels[0]?.id ?? "";
      }
    }
    return { checked, modelByReserve };
  }, [reserves, uploadedModels]);

  const [checked, setChecked] = useState(defaultState.checked);
  const [modelByReserve, setModelByReserve] = useState(
    defaultState.modelByReserve,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    const toLink = reserves.filter((r) => checked[r.id]);
    if (toLink.length === 0) {
      onClose();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // Sequential — the writes are tiny and back-pressure on SQLite is
      // friendlier than a Promise.all storm.
      for (const r of toLink) {
        const modelId = modelByReserve[r.id];
        if (!modelId) continue;
        await centauriApi.review(r.id, "confirm", { modelId });
      }
      onLinked();
      onClose();
    } catch (e) {
      setError(
        e instanceof CentauriApiError
          ? e.message
          : e instanceof Error
            ? e.message
            : "Linking failed",
      );
    } finally {
      setBusy(false);
    }
  };

  const checkedCount = Object.values(checked).filter(Boolean).length;
  const singleModel = uploadedModels.length === 1;

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-[80] grid place-items-center bg-black/60 backdrop-blur-[2px] p-4"
      onClick={busy ? undefined : onClose}
    >
      <div
        className="w-full max-w-[640px] max-h-[85vh] bg-surface border border-border rounded-xl shadow-drawer overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-3.5 border-b border-border-soft flex items-center gap-2">
          <Bookmark size={16} className="text-accent" />
          <h3 className="m-0 text-[14px] font-semibold text-fg flex-1 truncate">
            Link to a recent print?
          </h3>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="w-7 h-7 grid place-items-center rounded-md text-fg-3 hover:bg-bg-3 hover:text-fg transition-colors disabled:opacity-50"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        <div className="px-5 py-3 border-b border-border-soft text-[12.5px] text-fg-2">
          {singleModel ? (
            <>
              Just uploaded <strong className="text-fg">{uploadedModels[0].name}</strong>.
              You have {reserves.length} reserved print
              {reserves.length === 1 ? "" : "s"} from your Centauri waiting
              to be linked. Tick any that this upload satisfies.
            </>
          ) : (
            <>
              Just uploaded {uploadedModels.length} models. Tick any reserved
              prints these uploads satisfy, and pick which model each one
              links to.
            </>
          )}
        </div>

        {error && (
          <div className="mx-5 mt-3 px-3 py-2 rounded-md bg-danger-soft border border-danger/40 text-[12.5px] text-fg-2">
            <strong className="text-fg font-semibold">Error: </strong>
            {error}
          </div>
        )}

        <div className="flex-1 min-h-0 overflow-y-auto">
          <ul className="divide-y divide-border-soft">
            {reserves.map((ev) => {
              const isChecked = !!checked[ev.id];
              const [thumbErrored, _setThumbErrored] = [false, () => {}];
              return (
                <li key={ev.id} className="px-5 py-3 flex items-start gap-3">
                  <input
                    type="checkbox"
                    checked={isChecked}
                    onChange={(e) =>
                      setChecked((prev) => ({
                        ...prev,
                        [ev.id]: e.target.checked,
                      }))
                    }
                    disabled={busy}
                    className="mt-1 w-4 h-4 accent-accent"
                  />
                  <div className="w-12 h-12 flex-shrink-0 rounded-md bg-bg-3 overflow-hidden grid place-items-center">
                    {thumbErrored ? (
                      <Printer size={14} className="text-fg-3" />
                    ) : (
                      <img
                        src={centauriApi.thumbnailUrl(ev.id)}
                        alt=""
                        className="w-full h-full object-cover"
                      />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-[13px] text-fg truncate font-medium">
                      {ev.gcodeFilename}
                    </div>
                    <div className="text-[11.5px] text-fg-3 mt-0.5">
                      Reserved {fmtTime(ev.reservedAt ?? ev.startedAt)}
                    </div>
                    {!singleModel && (
                      <div className="mt-1.5">
                        <label className="text-[11px] text-fg-3 mr-2">
                          Link to:
                        </label>
                        <select
                          value={modelByReserve[ev.id] ?? ""}
                          onChange={(e) =>
                            setModelByReserve((prev) => ({
                              ...prev,
                              [ev.id]: e.target.value,
                            }))
                          }
                          disabled={busy || !isChecked}
                          className="text-[12px] bg-bg-3 border border-border-soft rounded px-2 py-1 text-fg disabled:opacity-50"
                        >
                          {uploadedModels.map((m) => (
                            <option key={m.id} value={m.id}>
                              {m.name}
                            </option>
                          ))}
                        </select>
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>

        <div className="px-5 py-3 border-t border-border-soft flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="px-3 py-1.5 rounded-md border border-border bg-surface hover:bg-surface-2 text-[12.5px] text-fg-2 transition-colors disabled:opacity-50"
          >
            Skip
          </button>
          <button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={busy || checkedCount === 0}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-accent text-accent-fg text-[12.5px] font-semibold hover:brightness-105 transition-all disabled:opacity-50"
          >
            {busy ? (
              <Loader2 size={13} className="animate-spin" />
            ) : (
              <Check size={13} />
            )}
            {busy
              ? "Linking…"
              : checkedCount === 0
                ? "Pick at least one"
                : `Link ${checkedCount} print${checkedCount === 1 ? "" : "s"}`}
          </button>
        </div>
      </div>
    </div>
  );
};

export default PostUploadLinkDialog;
