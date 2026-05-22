import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  CircleAlert,
  ExternalLink,
  FileUp,
  Loader2,
  RefreshCw,
  X,
} from "lucide-react";
import type { STLModel } from "../../types";
import {
  spoolmanApi,
  SpoolSummary,
  SliceParseResult,
} from "../../services/custom-spoolman";
import {
  printsApi,
  type Print,
  type PrintStatus,
  type SyncResult,
} from "../../services/custom-prints";

// One dialog, three modes:
//   "log"      — retrospective: status=completed (or failed/cancelled),
//                deducts spool on save. Primary flow for the Carbon.
//   "start"    — prospective: status=printing, no consume yet.
//   "complete" — finalize a started print: deducts spool now. Pre-fills
//                from the print's est values.
//
// Dual weight columns are present in log + complete modes; start hides
// the "Used" column entirely because nothing has been consumed yet.

export type DialogMode = "log" | "start" | "complete";

interface Props {
  open: boolean;
  mode: DialogMode;
  model: STLModel;
  existingPrint?: Print;
  spoolmanBaseUrl: string | null;
  onClose: () => void;
  onSaved: (print: Print, sync: SyncResult) => void;
}

interface FormState {
  spoolId: number | null;
  estWeightG: string;
  usedWeightG: string;
  estLengthMm: string;
  usedLengthMm: string;
  estDurationMin: string;
  actDurationMin: string;
  status: PrintStatus;
  notes: string;
}

const EMPTY_FORM: FormState = {
  spoolId: null,
  estWeightG: "",
  usedWeightG: "",
  estLengthMm: "",
  usedLengthMm: "",
  estDurationMin: "",
  actDurationMin: "",
  status: "completed",
  notes: "",
};

const numOrNull = (s: string): number | null => {
  const v = s.trim();
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const formatMinutes = (m: number | null): string => {
  if (m == null) return "—";
  const h = Math.floor(m / 60);
  const r = m % 60;
  return h > 0 ? `${h}h ${r}m` : `${r}m`;
};

const parseDurationInput = (raw: string): number | null => {
  // Accept "98", "1h 35m", "1h", "35m", "1:35", "01:35".
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^\d+$/.test(trimmed)) return parseInt(trimmed, 10);
  const colon = trimmed.match(/^(\d+):(\d{1,2})$/);
  if (colon) return parseInt(colon[1], 10) * 60 + parseInt(colon[2], 10);
  const hm = trimmed.match(/^(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?$/i);
  if (hm) {
    const h = parseInt(hm[1] || "0", 10);
    const m = parseInt(hm[2] || "0", 10);
    if (h > 0 || m > 0) return h * 60 + m;
  }
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
};

const LogPrintDialog: React.FC<Props> = ({
  open,
  mode,
  model,
  existingPrint,
  spoolmanBaseUrl,
  onClose,
  onSaved,
}) => {
  const [spools, setSpools] = useState<SpoolSummary[] | null>(null);
  const [spoolsError, setSpoolsError] = useState<string | null>(null);
  const [spoolsLoading, setSpoolsLoading] = useState(false);

  const [parseResult, setParseResult] = useState<SliceParseResult | null>(null);
  const [parsing, setParsing] = useState(false);
  const [parseSource, setParseSource] = useState<string | null>(null);

  const [form, setForm] = useState<FormState>(EMPTY_FORM);

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const uploadInputRef = useRef<HTMLInputElement>(null);
  // useState is asynchronous, so two click handlers firing in the same
  // event loop can both see submitting=false. The ref reads + writes
  // synchronously and guards the *real* race the user can trigger
  // (Enter + click, double-click on a slow network).
  const submitLockRef = useRef(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const firstFieldRef = useRef<HTMLSelectElement>(null);

  // Apply slicer parse results to empty form fields (don't clobber user input).
  const applyParse = (md: SliceParseResult, source: string) => {
    setParseResult(md);
    setParseSource(source);
    setForm((f) => ({
      ...f,
      estWeightG:
        f.estWeightG || md.estWeightG == null ? f.estWeightG : String(md.estWeightG),
      estLengthMm:
        f.estLengthMm || md.estLengthMm == null
          ? f.estLengthMm
          : String(Math.round(md.estLengthMm)),
      estDurationMin:
        f.estDurationMin || md.estDurationMin == null
          ? f.estDurationMin
          : String(md.estDurationMin),
      usedWeightG:
        mode !== "start" && !f.usedWeightG && md.estWeightG != null
          ? String(md.estWeightG)
          : f.usedWeightG,
      usedLengthMm:
        mode !== "start" && !f.usedLengthMm && md.estLengthMm != null
          ? String(Math.round(md.estLengthMm))
          : f.usedLengthMm,
      actDurationMin:
        mode !== "start" && !f.actDurationMin && md.estDurationMin != null
          ? String(md.estDurationMin)
          : f.actDurationMin,
    }));
  };

  // Reset + initial load when dialog opens.
  useEffect(() => {
    if (!open) return;
    setSubmitError(null);
    setParseResult(null);
    setParseSource(null);

    // Initial form state depends on mode.
    if (mode === "complete" && existingPrint) {
      const f = existingPrint.filaments[0];
      setForm({
        spoolId: f?.spoolId ?? null,
        estWeightG: f?.estWeightG != null ? String(f.estWeightG) : "",
        usedWeightG:
          f?.usedWeightG != null
            ? String(f.usedWeightG)
            : f?.estWeightG != null
              ? String(f.estWeightG)
              : "",
        estLengthMm: f?.estLengthMm != null ? String(Math.round(f.estLengthMm)) : "",
        usedLengthMm:
          f?.usedLengthMm != null
            ? String(Math.round(f.usedLengthMm))
            : f?.estLengthMm != null
              ? String(Math.round(f.estLengthMm))
              : "",
        estDurationMin:
          existingPrint.estDurationMin != null
            ? String(existingPrint.estDurationMin)
            : "",
        actDurationMin:
          existingPrint.actDurationMin != null
            ? String(existingPrint.actDurationMin)
            : existingPrint.estDurationMin != null
              ? String(existingPrint.estDurationMin)
              : "",
        status: "completed",
        notes: existingPrint.notes ?? "",
      });
    } else {
      setForm({ ...EMPTY_FORM, status: mode === "start" ? "printing" : "completed" });
    }

    // Fetch spools + parse the stored file in parallel.
    setSpoolsLoading(true);
    setSpoolsError(null);
    spoolmanApi
      .listSpools()
      .then((list) => setSpools(list))
      .catch((e) =>
        setSpoolsError(e instanceof Error ? e.message : "Failed to load spools"),
      )
      .finally(() => setSpoolsLoading(false));

    // Auto-parse only for non-complete modes; complete already has est values.
    if (mode !== "complete") {
      setParsing(true);
      spoolmanApi
        .parseSliceForModel(model.id)
        .then((md) => {
          if (!md.empty) applyParse(md, md.source);
          else {
            setParseResult(md);
            setParseSource(md.source);
          }
        })
        .catch(() => {
          /* parse failure is non-fatal — fields stay blank */
        })
        .finally(() => setParsing(false));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mode, model.id, existingPrint?.id]);

  const refreshSpools = async () => {
    setSpoolsLoading(true);
    try {
      const list = await spoolmanApi.listSpools();
      setSpools(list);
      setSpoolsError(null);
    } catch (e) {
      setSpoolsError(e instanceof Error ? e.message : "Failed to refresh");
    } finally {
      setSpoolsLoading(false);
    }
  };

  const handleUploadSlicedFile = async (
    e: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setParsing(true);
    try {
      const md = await spoolmanApi.parseSliceUpload(file);
      // applyParse is safe whether md.empty or not — when empty it just
      // updates the source label and leaves form fields untouched.
      applyParse(md, file.name);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Failed to parse file");
    } finally {
      setParsing(false);
      if (uploadInputRef.current) uploadInputRef.current.value = "";
    }
  };

  const groupedSpools = useMemo(() => {
    if (!spools) return [] as { material: string; items: SpoolSummary[] }[];
    const by: Record<string, SpoolSummary[]> = {};
    for (const s of spools) {
      const key = s.material ?? "Other";
      (by[key] = by[key] || []).push(s);
    }
    return Object.entries(by)
      .map(([material, items]) => ({ material, items }))
      .sort((a, b) => a.material.localeCompare(b.material));
  }, [spools]);

  const selectedSpool = useMemo(
    () => spools?.find((s) => s.id === form.spoolId) ?? null,
    [spools, form.spoolId],
  );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    // Synchronous ref read — wins races that submitting-state can't.
    if (submitLockRef.current) return;
    if (form.spoolId == null) {
      setSubmitError("Pick a spool first.");
      return;
    }
    submitLockRef.current = true;
    setSubmitting(true);
    setSubmitError(null);

    try {
      const estW = numOrNull(form.estWeightG);
      const usedW = numOrNull(form.usedWeightG);
      const estL = numOrNull(form.estLengthMm);
      const usedL = numOrNull(form.usedLengthMm);
      const estDur = parseDurationInput(form.estDurationMin);
      const actDur = parseDurationInput(form.actDurationMin);
      const notes = form.notes.trim() || null;

      let result: { print: Print; sync: SyncResult };
      if (mode === "complete" && existingPrint) {
        // Address the exact filament leg we're updating by its row id.
        // Disambiguates same-spool-twice prints.
        const targetLeg =
          existingPrint.filaments.find((f) => f.spoolId === form.spoolId) ??
          existingPrint.filaments[0];
        result = await printsApi.complete(existingPrint.id, {
          status: form.status,
          filaments: [
            {
              spoolId: form.spoolId,
              filamentRowId: targetLeg?.id,
              // Send used* for any terminal status — a failed print that
              // ate 28g still left 28g off the spool, and the user may
              // have weighed it. Status is outcome, not consumption.
              usedWeightG: usedW,
              usedLengthMm: usedL,
            },
          ],
          completedAt: Date.now(),
          actDurationMin: actDur,
          notes,
        });
      } else if (mode === "start") {
        result = await printsApi.createForModel(model.id, {
          status: "printing",
          filaments: [
            {
              spoolId: form.spoolId,
              estWeightG: estW,
              estLengthMm: estL,
            },
          ],
          estDurationMin: estDur,
          startedAt: Date.now(),
          notes,
        });
      } else {
        // mode === "log" — status may be completed/failed/cancelled.
        // Send used* regardless; backend deducts whatever's present.
        result = await printsApi.createForModel(model.id, {
          status: form.status,
          filaments: [
            {
              spoolId: form.spoolId,
              estWeightG: estW,
              usedWeightG: usedW,
              estLengthMm: estL,
              usedLengthMm: usedL,
            },
          ],
          estDurationMin: estDur,
          actDurationMin: actDur,
          completedAt: Date.now(),
          notes,
        });
      }
      onSaved(result.print, result.sync);
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSubmitting(false);
      submitLockRef.current = false;
    }
  };

  // a11y: Esc closes the dialog; autofocus first interactive field on open.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !submitLockRef.current) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    // Defer focus a tick so the select has its options populated.
    const t = window.setTimeout(() => firstFieldRef.current?.focus(), 50);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.clearTimeout(t);
    };
  }, [open, onClose]);

  if (!open) return null;

  const showUsedColumn = mode !== "start";
  const showStatusPicker = mode !== "start"; // start is implicitly "printing"

  const title =
    mode === "start"
      ? "Start a print"
      : mode === "complete"
        ? "Complete print"
        : "Log a print";

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/60 backdrop-blur-[2px] p-4"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="log-print-dialog-title"
        className="bg-bg-2 border border-border rounded-xl shadow-drawer w-full max-w-[560px] max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 flex items-center gap-3 border-b border-border-soft">
          <h2
            id="log-print-dialog-title"
            className="m-0 text-[15px] font-semibold text-fg flex-1 truncate"
          >
            {title}: <span className="font-normal text-fg-2">{model.name}</span>
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="w-8 h-8 grid place-items-center rounded-md text-fg-3 hover:bg-bg-3 hover:text-fg transition-colors"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        <form
          onSubmit={handleSubmit}
          className="flex-1 overflow-y-auto px-5 py-4 flex flex-col gap-4"
        >
          {/* Spool picker */}
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <label
                htmlFor="spool-select"
                className="text-[12.5px] font-medium text-fg-2"
              >
                Spool
              </label>
              <button
                type="button"
                onClick={() => void refreshSpools()}
                className="inline-flex items-center gap-1 text-[11.5px] text-fg-3 hover:text-fg"
                title="Refresh from Spoolman"
              >
                <RefreshCw size={11} className={spoolsLoading ? "animate-spin" : ""} />{" "}
                Refresh
              </button>
            </div>

            {spoolsError && (
              <div className="px-3 py-2 bg-danger/10 border border-danger/30 rounded-lg text-[12px] text-danger">
                {spoolsError}
              </div>
            )}

            <select
              ref={firstFieldRef}
              id="spool-select"
              value={form.spoolId ?? ""}
              onChange={(e) =>
                setForm((f) => ({
                  ...f,
                  spoolId: e.target.value ? Number(e.target.value) : null,
                }))
              }
              disabled={spoolsLoading || mode === "complete"}
              required
              className="w-full px-3 py-2.5 bg-surface border border-border rounded-lg text-[13px] text-fg outline-none focus:border-accent focus:ring-[3px] focus:ring-accent/15 transition-all disabled:opacity-70"
            >
              <option value="">
                {spoolsLoading ? "Loading spools…" : "Pick a spool"}
              </option>
              {groupedSpools.map((g) => (
                <optgroup key={g.material} label={g.material}>
                  {g.items.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label} —{" "}
                      {s.remainingWeight != null
                        ? `${Math.round(s.remainingWeight)}g`
                        : "?"}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>

            {selectedSpool && (
              <div className="flex items-center gap-2 text-[12px] text-fg-3 mt-0.5">
                <span
                  aria-hidden
                  className="w-3 h-3 rounded-full border border-border-soft"
                  style={{
                    backgroundColor: selectedSpool.colorHex
                      ? `#${selectedSpool.colorHex}`
                      : "#888",
                  }}
                />
                #{selectedSpool.id} • {selectedSpool.material} • Lot{" "}
                {selectedSpool.lotNr ?? "—"}
              </div>
            )}
          </div>

          {/* Weight + length + time, dual columns when applicable */}
          <div className="grid grid-cols-[1fr_auto_1fr_auto] sm:grid-cols-[2fr_1fr_1fr] gap-2 items-end">
            <div className="col-span-full grid grid-cols-1 sm:grid-cols-[1fr_1fr] gap-3">
              {/* Weight */}
              <Pair
                label="Weight (g)"
                est={form.estWeightG}
                used={form.usedWeightG}
                onEst={(v) => setForm((f) => ({ ...f, estWeightG: v }))}
                onUsed={(v) => setForm((f) => ({ ...f, usedWeightG: v }))}
                showUsed={showUsedColumn}
                placeholder="42.0"
                estLabel={parseResult?.estWeightG ?? null}
              />
              {/* Length */}
              <Pair
                label="Length (mm)"
                est={form.estLengthMm}
                used={form.usedLengthMm}
                onEst={(v) => setForm((f) => ({ ...f, estLengthMm: v }))}
                onUsed={(v) => setForm((f) => ({ ...f, usedLengthMm: v }))}
                showUsed={showUsedColumn}
                placeholder="13902"
                estLabel={parseResult?.estLengthMm ?? null}
              />
            </div>
            {/* Time */}
            <div className="col-span-full">
              <Pair
                label="Print time"
                est={form.estDurationMin}
                used={form.actDurationMin}
                onEst={(v) => setForm((f) => ({ ...f, estDurationMin: v }))}
                onUsed={(v) => setForm((f) => ({ ...f, actDurationMin: v }))}
                showUsed={showUsedColumn}
                placeholder="1h 35m"
                estLabel={parseResult?.estDurationMin ?? null}
                formatter={(n) => formatMinutes(n)}
              />
            </div>
          </div>

          {/* Status (log mode only) */}
          {showStatusPicker && (
            <div className="flex flex-col gap-1.5">
              <span className="text-[12.5px] font-medium text-fg-2">Status</span>
              <div className="inline-flex bg-bg-3 rounded-lg p-[3px] gap-0.5 self-start">
                {(["completed", "failed", "cancelled"] as PrintStatus[]).map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setForm((f) => ({ ...f, status: s }))}
                    className={`px-3 py-1.5 rounded-md text-[12.5px] capitalize transition-all ${
                      form.status === s
                        ? "bg-surface text-fg shadow-soft"
                        : "text-fg-3 hover:text-fg"
                    }`}
                  >
                    {s}
                  </button>
                ))}
              </div>
              {form.status === "completed" && (
                <p className="text-[11.5px] text-fg-3">
                  Completed prints require a used weight — leave the field
                  blank only if you mean cancelled.
                </p>
              )}
              {form.status !== "completed" && (
                <p className="text-[11.5px] text-fg-3">
                  Set used weight to whatever actually came off the spool
                  (failed prints often did consume material).
                </p>
              )}
            </div>
          )}

          {/* Notes */}
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="print-notes"
              className="text-[12.5px] font-medium text-fg-2"
            >
              Notes <span className="font-normal text-fg-3">(optional)</span>
            </label>
            <textarea
              id="print-notes"
              rows={2}
              value={form.notes}
              onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
              placeholder="warping on corner, fixed bed level next time…"
              className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-[13px] text-fg outline-none focus:border-accent focus:ring-[3px] focus:ring-accent/15 transition-all resize-y"
            />
          </div>

          {/* Slicer-file parse status + upload */}
          {mode !== "complete" && (
            <div className="px-3 py-2.5 bg-bg-3 border border-border-soft rounded-lg flex items-center gap-2.5 text-[12px]">
              {parsing ? (
                <>
                  <Loader2 size={13} className="animate-spin text-fg-3" />
                  <span className="text-fg-3">Parsing slicer file…</span>
                </>
              ) : parseResult && !parseResult.empty ? (
                <>
                  <Check size={13} className="text-success" />
                  <span className="text-fg-2">
                    Auto-filled from{" "}
                    <span className="font-mono text-fg">{parseSource}</span>
                  </span>
                </>
              ) : parseResult && parseResult.empty ? (
                <>
                  <CircleAlert size={13} className="text-fg-3" />
                  <span className="text-fg-3">
                    No slicer estimates in <span className="font-mono">{parseSource}</span>{" "}
                    — enter manually or upload a sliced file.
                  </span>
                </>
              ) : (
                <>
                  <CircleAlert size={13} className="text-fg-3" />
                  <span className="text-fg-3">
                    No slicer file available. Enter values manually or upload one.
                  </span>
                </>
              )}
              <button
                type="button"
                onClick={() => uploadInputRef.current?.click()}
                disabled={parsing}
                className="ml-auto inline-flex items-center gap-1 text-[12px] text-accent hover:underline disabled:opacity-50"
              >
                <FileUp size={12} /> Upload sliced file
              </button>
              <input
                ref={uploadInputRef}
                type="file"
                accept=".gcode,.gco,.g,.3mf"
                className="hidden"
                onChange={(e) => void handleUploadSlicedFile(e)}
              />
            </div>
          )}

          {submitError && (
            <div className="px-3 py-2.5 bg-danger/10 border border-danger/30 rounded-lg text-[12.5px] text-danger">
              {submitError}
            </div>
          )}
        </form>

        <div className="px-5 py-3.5 border-t border-border-soft flex items-center gap-2">
          {spoolmanBaseUrl && selectedSpool && (
            <a
              href={`${spoolmanBaseUrl.replace(/\/api\/v1\/?$/, "")}/spool/show/${selectedSpool.id}`}
              target="_blank"
              rel="noreferrer noopener"
              className="text-[11.5px] text-fg-3 hover:text-fg inline-flex items-center gap-1"
            >
              Spool in Spoolman <ExternalLink size={11} />
            </a>
          )}
          <div className="flex-1" />
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="px-3 py-2 rounded-lg border border-border bg-surface hover:bg-surface-2 text-[13px] text-fg-2 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={(() => {
              if (submitting) return true;
              if (form.spoolId == null) return true;
              // A completed print MUST record actual consumption — the
              // backend will reject otherwise, but block in the UI so the
              // user gets immediate feedback rather than a server 400.
              // Start mode (no terminal status yet) doesn't need this.
              const isTerminalCompleted =
                mode !== "start" && form.status === "completed";
              if (isTerminalCompleted) {
                const usedW = numOrNull(form.usedWeightG);
                const usedL = numOrNull(form.usedLengthMm);
                if (usedW == null && usedL == null) return true;
              }
              return false;
            })()}
            onClick={handleSubmit}
            className="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg bg-accent text-accent-fg text-[13px] font-semibold hover:brightness-105 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {submitting ? (
              <>
                <Loader2 size={14} className="animate-spin" /> Saving…
              </>
            ) : mode === "start" ? (
              "Start print"
            ) : mode === "complete" ? (
              "Complete & deduct"
            ) : (
              "Log & deduct"
            )}
          </button>
        </div>
      </div>
    </div>
  );
};

// Small helper for the dual est/used input pair.
const Pair: React.FC<{
  label: string;
  est: string;
  used: string;
  onEst: (v: string) => void;
  onUsed: (v: string) => void;
  showUsed: boolean;
  placeholder: string;
  estLabel: number | null;
  formatter?: (n: number) => string;
}> = ({
  label,
  est,
  used,
  onEst,
  onUsed,
  showUsed,
  placeholder,
  estLabel,
  formatter,
}) => {
  const estHint =
    estLabel != null ? (formatter ? formatter(estLabel) : String(estLabel)) : null;
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[12px] font-medium text-fg-2">{label}</span>
      <div
        className={`grid ${showUsed ? "grid-cols-2" : "grid-cols-1"} gap-2`}
      >
        <div className="flex flex-col gap-0.5">
          <input
            type="text"
            inputMode="decimal"
            value={est}
            onChange={(e) => onEst(e.target.value)}
            placeholder={placeholder}
            className="px-3 py-2 bg-surface border border-border rounded-lg text-[13px] text-fg outline-none focus:border-accent focus:ring-[3px] focus:ring-accent/15 transition-all"
          />
          <span className="text-[10.5px] text-fg-3 px-0.5">
            {showUsed ? "Estimated" : "Estimated value"}
            {estHint ? ` • slicer: ${estHint}` : ""}
          </span>
        </div>
        {showUsed && (
          <div className="flex flex-col gap-0.5">
            <input
              type="text"
              inputMode="decimal"
              value={used}
              onChange={(e) => onUsed(e.target.value)}
              placeholder={placeholder}
              className="px-3 py-2 bg-surface border border-border rounded-lg text-[13px] text-fg outline-none focus:border-accent focus:ring-[3px] focus:ring-accent/15 transition-all"
            />
            <span className="text-[10.5px] text-fg-3 px-0.5">Actual</span>
          </div>
        )}
      </div>
    </div>
  );
};

export default LogPrintDialog;
