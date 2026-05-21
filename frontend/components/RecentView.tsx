import React, { useMemo } from "react";
import { Menu as MenuIcon, ChevronLeft, FileBox, Clock } from "lucide-react";
import { STLModel } from "../types";

interface RecentViewProps {
  models: STLModel[];
  onOpenModel: (model: STLModel) => void;
  onOpenMobileSidebar?: () => void;
  onBack: () => void;
}

const formatSize = (bytes: number) => {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
};

const extOf = (name: string) => {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot + 1).toUpperCase();
};

const startOfDay = (d: Date) => {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
};

const startOfWeek = (d: Date) => {
  const x = startOfDay(d);
  const dow = (x.getDay() + 6) % 7;
  x.setDate(x.getDate() - dow);
  return x;
};

const startOfMonth = (d: Date) => {
  const x = startOfDay(d);
  x.setDate(1);
  return x;
};

type GroupKey = "today" | "yesterday" | "thisWeek" | "thisMonth" | "older";

const GROUP_LABELS: Record<GroupKey, string> = {
  today: "Today",
  yesterday: "Yesterday",
  thisWeek: "Earlier this week",
  thisMonth: "Earlier this month",
  older: "Older",
};

const DAY_MS = 24 * 60 * 60 * 1000;

const RecentView: React.FC<RecentViewProps> = ({
  models,
  onOpenModel,
  onOpenMobileSidebar,
  onBack,
}) => {
  const stats = useMemo(() => {
    const now = new Date();
    const today0 = startOfDay(now).getTime();
    const sevenAgo = today0 - 6 * DAY_MS;
    const thirtyAgo = today0 - 29 * DAY_MS;
    let todayCount = 0;
    let sevenCount = 0;
    let thirtyCount = 0;
    for (const m of models) {
      if (m.dateAdded >= today0) todayCount++;
      if (m.dateAdded >= sevenAgo) sevenCount++;
      if (m.dateAdded >= thirtyAgo) thirtyCount++;
    }
    return { todayCount, sevenCount, thirtyCount };
  }, [models]);

  const buckets = useMemo(() => {
    const now = new Date();
    const today0 = startOfDay(now);
    const result: { day: Date; count: number }[] = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date(today0);
      d.setDate(d.getDate() - i);
      result.push({ day: d, count: 0 });
    }
    for (const m of models) {
      const diff = Math.floor(
        (today0.getTime() - startOfDay(new Date(m.dateAdded)).getTime()) /
          DAY_MS,
      );
      if (diff >= 0 && diff < 30) {
        result[29 - diff].count++;
      }
    }
    return result;
  }, [models]);
  const maxBucket = Math.max(1, ...buckets.map((b) => b.count));

  const grouped = useMemo(() => {
    const now = new Date();
    const today0 = startOfDay(now).getTime();
    const yesterday0 = today0 - DAY_MS;
    const week0 = startOfWeek(now).getTime();
    const month0 = startOfMonth(now).getTime();
    const groups: Record<GroupKey, STLModel[]> = {
      today: [],
      yesterday: [],
      thisWeek: [],
      thisMonth: [],
      older: [],
    };
    const sorted = [...models].sort((a, b) => b.dateAdded - a.dateAdded);
    for (const m of sorted) {
      if (m.dateAdded >= today0) groups.today.push(m);
      else if (m.dateAdded >= yesterday0) groups.yesterday.push(m);
      else if (m.dateAdded >= week0) groups.thisWeek.push(m);
      else if (m.dateAdded >= month0) groups.thisMonth.push(m);
      else groups.older.push(m);
    }
    return groups;
  }, [models]);

  const isEmpty = models.length === 0;

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
          Recent
        </h1>
      </header>

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-[920px] mx-auto w-full px-4 md:px-7 py-7">
          <div className="mb-8 pb-6 border-b border-border-soft">
            <h2 className="text-[28px] font-semibold -tracking-[0.02em] text-fg m-0">
              Recent activity
            </h2>
            <p className="text-fg-3 text-[13.5px] mt-1.5 max-w-[480px]">
              What you've added to the vault — the past month at a glance.
            </p>
            <div className="grid grid-cols-3 gap-3 mt-5 max-w-[460px]">
              {[
                { label: "Today", value: stats.todayCount },
                { label: "Last 7 days", value: stats.sevenCount },
                { label: "Last 30 days", value: stats.thirtyCount },
              ].map((s) => (
                <div
                  key={s.label}
                  className="px-3.5 py-3 rounded-[10px] border border-border-soft bg-surface"
                >
                  <div className="font-mono text-[10.5px] uppercase tracking-wider text-fg-3">
                    {s.label}
                  </div>
                  <div className="text-[24px] font-semibold -tracking-[0.02em] text-fg mt-1">
                    {s.value}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <section className="mb-9">
            <h3 className="m-0 mb-1 text-[15px] font-semibold -tracking-[0.005em] text-fg">
              30-day activity
            </h3>
            <p className="m-0 mb-4 text-[13px] text-fg-3">
              One bar per day — hover for the date and count.
            </p>
            <div className="flex items-end gap-[3px] h-[64px] px-2 py-2 rounded-[10px] border border-border-soft bg-surface">
              {buckets.map((b, i) => {
                const heightPct = (b.count / maxBucket) * 100;
                const tooltip = `${b.count} model${b.count === 1 ? "" : "s"} · ${b.day.toLocaleDateString()}`;
                return (
                  <div
                    key={i}
                    className="flex-1 flex flex-col justify-end h-full group relative min-w-0"
                    title={tooltip}
                  >
                    <div
                      className={`w-full rounded-sm transition-colors ${
                        b.count > 0
                          ? "bg-accent/60 group-hover:bg-accent"
                          : "bg-bg-3 group-hover:bg-border-soft"
                      }`}
                      style={{
                        height:
                          b.count > 0 ? `${Math.max(heightPct, 8)}%` : "3px",
                      }}
                    />
                  </div>
                );
              })}
            </div>
          </section>

          {isEmpty ? (
            <div className="rounded-[10px] border border-border-soft bg-surface px-6 py-12 text-center">
              <Clock size={28} className="text-fg-3 mx-auto" />
              <div className="text-[15px] font-medium text-fg mt-3">
                No models yet
              </div>
              <div className="text-[13px] text-fg-3 mt-1">
                Upload or import to see them show up here.
              </div>
            </div>
          ) : (
            (Object.keys(GROUP_LABELS) as GroupKey[]).map((key) => {
              const items = grouped[key];
              if (items.length === 0) return null;
              return (
                <section key={key} className="mb-7">
                  <div className="flex items-baseline gap-2 mb-3">
                    <h3 className="m-0 text-[14px] font-semibold -tracking-[0.005em] text-fg">
                      {GROUP_LABELS[key]}
                    </h3>
                    <span className="font-mono text-[11px] text-fg-3">
                      {items.length}
                    </span>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    {items.map((m) => (
                      <RecentRow
                        key={m.id}
                        model={m}
                        onOpen={() => onOpenModel(m)}
                      />
                    ))}
                  </div>
                </section>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
};

const RecentRow: React.FC<{ model: STLModel; onOpen: () => void }> = ({
  model,
  onOpen,
}) => {
  const ext = extOf(model.name);
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      className="grid grid-cols-[44px_1fr_auto] items-center gap-3 px-3 py-2 rounded-card bg-surface border border-border-soft hover:border-border transition-colors cursor-pointer"
    >
      <div
        className="h-9 w-11 rounded-md border border-border-soft grid place-items-center overflow-hidden"
        style={{
          background:
            "radial-gradient(ellipse at 50% 100%, oklch(var(--accent) / 0.08), transparent 60%), linear-gradient(180deg, oklch(var(--bg-2)), oklch(var(--bg-3)))",
        }}
      >
        {model.thumbnail ? (
          <img
            src={model.thumbnail}
            alt=""
            className="h-full w-full object-cover"
          />
        ) : (
          <FileBox size={16} className="text-fg-3" />
        )}
      </div>
      <div className="min-w-0">
        <div className="text-[13.5px] font-medium text-fg truncate">
          {model.name}
        </div>
        <div className="font-mono text-[11px] text-fg-3 flex items-center gap-2">
          <span>{formatSize(model.size)}</span>
          <span className="w-0.5 h-0.5 bg-current rounded-full" />
          <span>{new Date(model.dateAdded).toLocaleString()}</span>
        </div>
      </div>
      {ext && (
        <span className="font-mono text-[10px] bg-bg-3 text-fg-2 px-1.5 py-0.5 rounded">
          {ext}
        </span>
      )}
    </div>
  );
};

export default RecentView;
