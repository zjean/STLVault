import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Calendar,
  Check,
  CheckCircle2,
  ChevronLeft,
  CircleSlash,
  Clock,
  ExternalLink,
  Loader2,
  Menu as MenuIcon,
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
  type SpoolmanSettings,
  type SpoolSummary,
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

const STATUS_TONES: Record<PrintStatus, { icon: React.ReactNode; tone: string }> = {
  completed: { icon: <Check size={12} />, tone: "text-success" },
  printing: { icon: <Loader2 size={12} className="animate-spin" />, tone: "text-accent" },
  failed: { icon: <XCircle size={12} />, tone: "text-danger" },
  cancelled: { icon: <CircleSlash size={12} />, tone: "text-fg-3" },
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
    setLoading(true);
    setError(null);
    try {
      const [s, spoolList] = await Promise.all([
        spoolmanApi.getSettings(),
        spoolmanApi.listSpools().catch(() => [] as SpoolSummary[]),
      ]);
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
      setPrints(list);
      setWindowRollup(monthly);
      setAllTime(lifetime);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load history");
    } finally {
      setLoading(false);
    }
  }, [statusFilter, spoolFilter, sinceMs, monthSinceMs]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

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
        <div className="max-w-[920px] mx-auto w-full px-4 md:px-7 py-7 flex flex-col gap-6">
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
        </div>
      </div>
    </div>
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
  const minutes = print.actDurationMin ?? print.estDurationMin ?? null;
  const isUnsynced = print.status === "completed" && !print.syncedToSpoolman;
  const tone = STATUS_TONES[print.status];

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
            className={`inline-flex items-center gap-1 font-medium ${tone.tone}`}
          >
            {isUnsynced ? (
              <AlertTriangle size={11} />
            ) : (
              tone.icon
            )}
            {isUnsynced
              ? "Logged, not synced"
              : print.status[0].toUpperCase() + print.status.slice(1)}
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
