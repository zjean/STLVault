import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Calendar,
  Check,
  ChevronLeft,
  CircleSlash,
  Clock,
  ExternalLink,
  Loader2,
  Menu as MenuIcon,
  Play,
  Printer,
  RefreshCw,
  Scale,
  XCircle,
} from "lucide-react";
import type { STLModel } from "../../types";
import {
  printsApi,
  type Print,
  type PrintStatus,
} from "../../services/custom-prints";
import {
  spoolmanApi,
  spoolmanWebUrl,
  type SpoolmanSettings,
  type SpoolSummary,
  type ReconciliationReport,
} from "../../services/custom-spoolman";

// Global Prints view — listed in the Sidebar as "Prints".
//
// Top: rollup card with month/all-time totals (count, weight, time).
// Filters: status, spool. Date range presets — last 7/30/90 days, all.
// Rows: status pill, status-dated label, model name (clickable to open
// the model in DetailPanel), spool with color swatch, weight, time.

interface Props {
  models: STLModel[];
  onBack: () => void;
  onOpenMobileSidebar?: () => void;
  onOpenModel: (m: STLModel) => void;
}

const ALL_STATUSES: PrintStatus[] = [
  "completed",
  "printing",
  "failed",
  "cancelled",
];

// "printing" does NOT mean the printer is observably running — there's
// no live connection to the printer. It means the user clicked Start
// and hasn't reported an outcome yet. Static Play icon is honest;
// stale-detection (>24h) is in HistoryRow.
const STATUS_TONES: Record<PrintStatus, { icon: React.ReactNode; tone: string; text: string }> = {
  completed: { icon: <Check size={12} />, tone: "text-success", text: "Completed" },
  printing: { icon: <Play size={12} />, tone: "text-accent", text: "Started" },
  failed: { icon: <XCircle size={12} />, tone: "text-danger", text: "Failed" },
  cancelled: { icon: <CircleSlash size={12} />, tone: "text-fg-3", text: "Cancelled" },
};

const DATE_PRESETS = [
  { label: "Last 7 days", days: 7 },
  { label: "Last 30 days", days: 30 },
  { label: "Last 90 days", days: 90 },
  { label: "All time", days: null },
] as const;

const formatMinutes = (m: number): string => {
  if (!m) return "0m";
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h === 0) return `${r}m`;
  return r === 0 ? `${h}h` : `${h}h ${r}m`;
};

const formatHoursDisplay = (m: number): string => {
  if (m < 60) return `${m}m`;
  const h = m / 60;
  return h >= 10 ? `${Math.round(h)}h` : `${h.toFixed(1)}h`;
};

const formatGrams = (g: number): string => {
  if (g < 1000) return `${Math.round(g)}g`;
  return `${(g / 1000).toFixed(g >= 10000 ? 0 : 2)}kg`;
};

const formatDateTime = (ms: number | null): string => {
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

const PrintsHistoryView: React.FC<Props> = ({
  models,
  onBack,
  onOpenMobileSidebar,
  onOpenModel,
}) => {
  const [settings, setSettings] = useState<SpoolmanSettings | null>(null);
  const [prints, setPrints] = useState<Print[] | null>(null);
  const [spools, setSpools] = useState<SpoolSummary[]>([]);
  const [allTime, setAllTime] = useState<{
    count: number;
    totalMinutes: number;
    totalWeightG: number;
  } | null>(null);
  const [windowRollup, setWindowRollup] = useState<{
    count: number;
    totalMinutes: number;
    totalWeightG: number;
  } | null>(null);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Request-seq guard: rapid filter changes (Range → 7d, 30d, 90d) fire
  // overlapping loads; only the latest invocation's results should land.
  // Each loadAll captures its sequence number; setState calls bail out
  // if a newer request has since started.
  const requestSeqRef = useRef(0);

  // Reconciliation panel state — loads independently from the prints
  // list so a slow/down Spoolman doesn't block the history view.
  const [recon, setRecon] = useState<ReconciliationReport | null>(null);
  const [reconLoading, setReconLoading] = useState(false);
  const [reconError, setReconError] = useState<string | null>(null);
  const [reconOpen, setReconOpen] = useState(false);

  // Filters
  const [statusFilter, setStatusFilter] = useState<PrintStatus | "">("");
  const [spoolFilter, setSpoolFilter] = useState<number | "">("");
  const [daysFilter, setDaysFilter] = useState<number | null>(30);

  const sinceMs = useMemo(() => {
    if (daysFilter == null) return undefined;
    return Date.now() - daysFilter * 86400_000;
  }, [daysFilter]);

  const monthSinceMs = useMemo(() => {
    const d = new Date();
    d.setDate(1);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }, []);

  const loadAll = useCallback(async () => {
    const mySeq = ++requestSeqRef.current;
    setLoading(true);
    setError(null);
    try {
      const [s, spoolList] = await Promise.all([
        spoolmanApi.getSettings(),
        spoolmanApi.listSpools().catch(() => [] as SpoolSummary[]),
      ]);
      if (mySeq !== requestSeqRef.current) return;
      setSettings(s);
      setSpools(spoolList);

      // Fetch prints + rollups in parallel.
      const [list, monthly, lifetime] = await Promise.all([
        printsApi.listAll({
          limit: 200,
          status: statusFilter || undefined,
          spoolId: spoolFilter === "" ? undefined : spoolFilter,
          sinceMs,
        }),
        printsApi.rollup(monthSinceMs),
        printsApi.rollup(0),
      ]);
      if (mySeq !== requestSeqRef.current) return;
      setPrints(list);
      setWindowRollup(monthly);
      setAllTime(lifetime);
    } catch (e) {
      if (mySeq !== requestSeqRef.current) return;
      setError(e instanceof Error ? e.message : "Failed to load history");
    } finally {
      if (mySeq === requestSeqRef.current) setLoading(false);
    }
  }, [statusFilter, spoolFilter, sinceMs, monthSinceMs]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const loadReconciliation = useCallback(async () => {
    setReconLoading(true);
    setReconError(null);
    try {
      setRecon(await spoolmanApi.reconciliation());
    } catch (e) {
      setReconError(e instanceof Error ? e.message : "Failed to load reconciliation");
    } finally {
      setReconLoading(false);
    }
  }, []);

  // Lazy-fetch when the user opens the panel — saves a Spoolman roundtrip
  // for users who never look at it. The `reconError == null` guard prevents
  // an infinite refetch loop when the endpoint errors (e.g. 409 from an
  // unconfigured Spoolman client): without it, the effect re-fires every time
  // `reconLoading` flips back to false while `recon` stays null. Manual retry
  // still works via the Refresh button, which clears `reconError` first.
  useEffect(() => {
    if (reconOpen && recon == null && !reconLoading && reconError == null) {
      void loadReconciliation();
    }
  }, [reconOpen, recon, reconLoading, reconError, loadReconciliation]);

  const modelById = useMemo(() => {
    const m: Record<string, STLModel> = {};
    for (const x of models) m[x.id] = x;
    return m;
  }, [models]);

  return (
    <div className="flex-1 min-w-0 flex flex-col overflow-hidden bg-bg">
      {/* Header */}
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
          Prints
        </h1>
        <div className="ml-auto">
          <button
            type="button"
            onClick={() => void loadAll()}
            disabled={loading}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-fg-2 hover:bg-bg-3 hover:text-fg transition-colors text-[12.5px]"
            aria-label="Refresh"
          >
            <RefreshCw size={13} className={loading ? "animate-spin" : ""} />
            Refresh
          </button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto">
        <div className="w-full px-4 md:px-7 py-7 flex flex-col gap-6">
          {/* Rollup cards */}
          <section className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <RollupCard
              title="This month"
              icon={<Calendar size={14} />}
              data={windowRollup}
              loading={loading && windowRollup == null}
            />
            <RollupCard
              title="All time"
              icon={<Printer size={14} />}
              data={allTime}
              loading={loading && allTime == null}
            />
          </section>

          {/* Filter bar */}
          <section className="flex flex-wrap items-center gap-3 px-4 py-3 bg-surface border border-border-soft rounded-[10px]">
            <div className="flex items-center gap-1.5">
              <span className="text-[12px] font-medium text-fg-3">Range</span>
              <div className="inline-flex bg-bg-3 rounded-md p-[3px] gap-0.5">
                {DATE_PRESETS.map((p) => {
                  const active = daysFilter === p.days;
                  return (
                    <button
                      key={p.label}
                      type="button"
                      onClick={() => setDaysFilter(p.days)}
                      className={`px-2.5 py-1 rounded text-[11.5px] transition-all ${
                        active
                          ? "bg-surface text-fg shadow-soft"
                          : "text-fg-3 hover:text-fg"
                      }`}
                    >
                      {p.label}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="flex items-center gap-1.5">
              <label
                htmlFor="status-filter"
                className="text-[12px] font-medium text-fg-3"
              >
                Status
              </label>
              <select
                id="status-filter"
                value={statusFilter}
                onChange={(e) =>
                  setStatusFilter((e.target.value as PrintStatus) || "")
                }
                className="px-2.5 py-1 bg-bg-3 border-0 rounded text-[12.5px] text-fg outline-none focus:ring-2 focus:ring-accent/30"
              >
                <option value="">All</option>
                {ALL_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s[0].toUpperCase() + s.slice(1)}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex items-center gap-1.5">
              <label
                htmlFor="spool-filter"
                className="text-[12px] font-medium text-fg-3"
              >
                Spool
              </label>
              <select
                id="spool-filter"
                value={spoolFilter}
                onChange={(e) =>
                  setSpoolFilter(e.target.value === "" ? "" : Number(e.target.value))
                }
                className="px-2.5 py-1 bg-bg-3 border-0 rounded text-[12.5px] text-fg outline-none focus:ring-2 focus:ring-accent/30 max-w-[240px]"
              >
                <option value="">All spools</option>
                {spools.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </select>
            </div>
          </section>

          {error && (
            <div className="px-3 py-2 bg-danger/10 border border-danger/30 rounded-lg text-[12.5px] text-danger">
              {error}
            </div>
          )}

          {/* Print rows */}
          {loading && prints == null ? (
            <div className="text-[13px] text-fg-3 inline-flex items-center gap-2 px-1">
              <Loader2 size={13} className="animate-spin" /> Loading…
            </div>
          ) : prints && prints.length === 0 ? (
            <p className="text-[13px] text-fg-3 px-1">
              No prints in this range.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {prints?.map((p) => {
                const model = modelById[p.modelId] ?? null;
                return (
                  <HistoryRow
                    key={p.id}
                    print={p}
                    model={model}
                    spoolmanBaseUrl={settings?.baseUrl ?? null}
                    onOpenModel={() => model && onOpenModel(model)}
                  />
                );
              })}
            </ul>
          )}

          {/* Reconciliation — collapsed by default to keep the page light. */}
          <ReconciliationPanel
            open={reconOpen}
            onToggle={() => setReconOpen((v) => !v)}
            report={recon}
            loading={reconLoading}
            error={reconError}
            spoolmanBaseUrl={settings?.baseUrl ?? null}
            onRefresh={() => void loadReconciliation()}
          />
        </div>
      </div>
    </div>
  );
};

// --- Reconciliation panel ---
//
// STLVault is a self-reported ledger. The user can forget to log a print
// (Spoolman moves; STLVault doesn't), log a print they didn't actually
// run (STLVault moves; nothing else), or consume material outside of
// STLVault entirely. The reconciliation panel surfaces the gap so it's
// glanceable instead of being a private worry.

const ReconciliationPanel: React.FC<{
  open: boolean;
  onToggle: () => void;
  report: ReconciliationReport | null;
  loading: boolean;
  error: string | null;
  spoolmanBaseUrl: string | null;
  onRefresh: () => void;
}> = ({ open, onToggle, report, loading, error, spoolmanBaseUrl, onRefresh }) => {
  const totalGap = report?.totals.gapG ?? 0;
  const gapTone =
    Math.abs(totalGap) < 1
      ? "text-fg-3"
      : totalGap > 0
        ? "text-warning"
        : "text-accent";

  return (
    <section className="mt-2 rounded-[10px] border border-border-soft bg-surface">
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-surface-2 transition-colors rounded-[10px]"
        aria-expanded={open}
      >
        <Scale size={14} className="text-fg-3" />
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-medium text-fg">
            Reconciliation with Spoolman
          </div>
          <div className="text-[11.5px] text-fg-3">
            {report
              ? `Spoolman ${formatGrams(report.totals.spoolmanUsedG)} used · ` +
                `STLVault ${formatGrams(report.totals.stlvaultLoggedG)} logged · ` +
                `gap ${totalGap >= 0 ? "+" : ""}${formatGrams(totalGap)}`
              : "Where forgotten prints and off-vault consumption show up"}
          </div>
        </div>
        {report && (
          <span className={`text-[14px] font-mono ${gapTone}`}>
            {totalGap >= 0 ? "+" : ""}
            {formatGrams(totalGap)}
          </span>
        )}
        <ChevronLeft
          size={14}
          className={`text-fg-3 transition-transform ${open ? "-rotate-90" : "rotate-180"}`}
        />
      </button>

      {open && (
        <div className="border-t border-border-soft px-4 py-3">
          {loading && !report ? (
            <div className="text-[12.5px] text-fg-3 inline-flex items-center gap-2">
              <Loader2 size={12} className="animate-spin" /> Loading…
            </div>
          ) : error ? (
            <div className="px-3 py-2 bg-danger/10 border border-danger/30 rounded-lg text-[12.5px] text-danger">
              {error}
            </div>
          ) : report && report.rows.length === 0 ? (
            <p className="text-[12.5px] text-fg-3 m-0">
              No spools to reconcile yet.
            </p>
          ) : report ? (
            <>
              <p className="text-[11.5px] text-fg-3 m-0 mb-2 leading-relaxed">
                Positive gap = Spoolman used more than STLVault logged (probably
                a forgotten print or off-vault consumption). Negative gap =
                STLVault logged more than Spoolman has used (rare — likely a
                manual Spoolman edit). Largest gaps first.
              </p>
              <ul className="flex flex-col gap-1">
                {report.rows.map((r) => {
                  const tone =
                    Math.abs(r.gapG) < 1
                      ? "text-fg-3"
                      : r.gapG > 0
                        ? "text-warning"
                        : "text-accent";
                  return (
                    <li
                      key={r.id}
                      className="flex items-center gap-2 px-3 py-1.5 bg-bg-3 border border-border-soft rounded-md text-[12.5px]"
                    >
                      {r.colorHex && (
                        <span
                          aria-hidden
                          className="w-3 h-3 rounded-full border border-border-soft flex-shrink-0"
                          style={{ backgroundColor: `#${r.colorHex}` }}
                        />
                      )}
                      <span className="flex-1 min-w-0 truncate text-fg">
                        {r.label}
                        {r.archived && (
                          <span className="text-fg-3"> (archived)</span>
                        )}
                      </span>
                      <span className="font-mono text-fg-3 flex-shrink-0">
                        STL {formatGrams(r.stlvaultLoggedG)} · SM{" "}
                        {formatGrams(r.spoolmanUsedG)}
                      </span>
                      <span
                        className={`font-mono font-medium flex-shrink-0 ${tone}`}
                      >
                        {r.gapG >= 0 ? "+" : ""}
                        {formatGrams(r.gapG)}
                      </span>
                      {spoolmanBaseUrl && r.presentInSpoolman && (
                        <a
                          href={`${spoolmanWebUrl(spoolmanBaseUrl)}/spool/show/${r.id}`}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="text-accent hover:underline inline-flex items-center"
                          title={`Open spool #${r.id} in Spoolman`}
                        >
                          <ExternalLink size={10} />
                        </a>
                      )}
                    </li>
                  );
                })}
              </ul>
              <div className="mt-2 flex justify-end">
                <button
                  type="button"
                  onClick={onRefresh}
                  disabled={loading}
                  className="inline-flex items-center gap-1 text-[11.5px] text-fg-3 hover:text-fg disabled:opacity-50"
                >
                  <RefreshCw size={11} className={loading ? "animate-spin" : ""} />{" "}
                  Refresh
                </button>
              </div>
            </>
          ) : null}
        </div>
      )}
    </section>
  );
};

const RollupCard: React.FC<{
  title: string;
  icon: React.ReactNode;
  data: { count: number; totalMinutes: number; totalWeightG: number } | null;
  loading: boolean;
}> = ({ title, icon, data, loading }) => {
  return (
    <div className="rounded-[10px] border border-border-soft bg-surface px-4 py-3.5">
      <div className="flex items-center gap-1.5 text-fg-3 text-[11.5px] font-medium uppercase tracking-[0.06em]">
        {icon}
        {title}
      </div>
      {loading ? (
        <div className="mt-3 text-[13px] text-fg-3 inline-flex items-center gap-2">
          <Loader2 size={12} className="animate-spin" /> …
        </div>
      ) : data ? (
        <div className="mt-2 flex items-baseline gap-5 flex-wrap">
          <div>
            <div className="text-[24px] font-semibold text-fg leading-tight">
              {data.count}
            </div>
            <div className="text-[11.5px] text-fg-3">prints</div>
          </div>
          <Stat
            icon={<Scale size={11} />}
            value={formatGrams(data.totalWeightG)}
            label="filament"
          />
          <Stat
            icon={<Clock size={11} />}
            value={formatHoursDisplay(data.totalMinutes)}
            label="print time"
          />
        </div>
      ) : (
        <div className="mt-2 text-fg-3 text-[13px]">—</div>
      )}
    </div>
  );
};

const Stat: React.FC<{
  icon: React.ReactNode;
  value: string;
  label: string;
}> = ({ icon, value, label }) => (
  <div>
    <div className="text-[18px] font-mono font-medium text-fg flex items-center gap-1.5 leading-tight">
      {icon} {value}
    </div>
    <div className="text-[11.5px] text-fg-3">{label}</div>
  </div>
);

const HistoryRow: React.FC<{
  print: Print;
  model: STLModel | null;
  spoolmanBaseUrl: string | null;
  onOpenModel: () => void;
}> = ({ print, model, spoolmanBaseUrl, onOpenModel }) => {
  const f = print.filaments[0];
  const weight = f?.usedWeightG ?? f?.estWeightG ?? null;
  // Prefer wall-clock (user-observed), fall back to slicer estimate.
  const minutes = print.wallClockMin ?? print.estDurationMin ?? null;
  const isUnsynced = print.status === "completed" && !print.syncedToSpoolman;
  const tone = STATUS_TONES[print.status];

  // A "Started" row that's older than 24h is almost certainly a
  // forgotten one — the user clicked Start and never came back to
  // mark the outcome. Flag it differently so the dashboard doesn't
  // imply a live in-progress print.
  const startedMs = print.startedAt ?? print.createdAt;
  const isStalePrinting =
    print.status === "printing" &&
    startedMs != null &&
    Date.now() - startedMs > 24 * 60 * 60 * 1000;

  const when =
    print.completedAt ?? print.startedAt ?? print.createdAt;

  return (
    <li className="flex items-stretch gap-3 px-3.5 py-3 bg-surface border border-border-soft rounded-[10px] hover:border-border transition-colors">
      {/* Thumbnail */}
      <button
        type="button"
        onClick={onOpenModel}
        disabled={!model}
        className="w-16 h-16 rounded-md bg-bg-3 border border-border-soft overflow-hidden flex-shrink-0 grid place-items-center hover:border-accent transition-colors disabled:cursor-default disabled:hover:border-border-soft"
      >
        {model?.thumbnail ? (
          <img
            src={model.thumbnail}
            alt=""
            className="w-full h-full object-cover"
          />
        ) : (
          <Printer size={20} className="text-fg-3" />
        )}
      </button>

      {/* Main */}
      <div className="flex-1 min-w-0 flex flex-col gap-1">
        <div className="flex items-center gap-2 min-w-0">
          <button
            type="button"
            onClick={onOpenModel}
            disabled={!model}
            className="text-[13.5px] font-medium text-fg hover:text-accent transition-colors truncate text-left disabled:hover:text-fg disabled:cursor-default"
          >
            {model?.name ?? <span className="italic text-fg-3">model deleted</span>}
          </button>
        </div>
        <div className="flex items-center gap-2 text-[12px] min-w-0">
          <span
            className={`inline-flex items-center gap-1 font-medium ${
              isStalePrinting ? "text-warning" : tone.tone
            }`}
          >
            {isUnsynced || isStalePrinting ? (
              <AlertTriangle size={11} />
            ) : (
              tone.icon
            )}
            {isUnsynced
              ? "Logged, not synced"
              : isStalePrinting
                ? "Started — awaiting outcome"
                : tone.text}
          </span>
          <span className="text-fg-3">•</span>
          <span className="text-fg-3">{formatDateTime(when)}</span>
        </div>
        <div className="flex items-center gap-2 text-[12px] min-w-0">
          {f?.filamentColor && (
            <span
              aria-hidden
              className="w-3 h-3 rounded-full border border-border-soft flex-shrink-0"
              style={{ backgroundColor: `#${f.filamentColor}` }}
            />
          )}
          <span className="text-fg-2 truncate min-w-0">
            {f?.spoolLabel ?? (f?.spoolId ? `Spool #${f.spoolId}` : "—")}
          </span>
        </div>
        {print.notes && (
          <p className="text-[11.5px] text-fg-3 italic m-0 truncate">
            "{print.notes}"
          </p>
        )}
      </div>

      {/* Right metrics */}
      <div className="flex flex-col items-end justify-center gap-0.5 text-[12.5px] flex-shrink-0">
        <span className="font-mono text-fg">
          {weight != null ? `${weight}g` : "—"}
        </span>
        <span className="font-mono text-fg-3">
          {minutes != null ? formatMinutes(minutes) : "—"}
        </span>
        {spoolmanBaseUrl && f && (
          <a
            href={`${spoolmanBaseUrl.replace(/\/api\/v1\/?$/, "")}/spool/show/${f.spoolId}`}
            target="_blank"
            rel="noreferrer noopener"
            className="text-[11px] text-fg-3 hover:text-fg inline-flex items-center gap-1 mt-1"
            onClick={(e) => e.stopPropagation()}
          >
            Spool <ExternalLink size={9} />
          </a>
        )}
      </div>
    </li>
  );
};

export default PrintsHistoryView;
