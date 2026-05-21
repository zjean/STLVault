import React, { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Menu as MenuIcon,
  ChevronLeft,
  FileBox,
  Pencil,
  ExternalLink,
  Check,
  X,
} from "lucide-react";
import { STLModel } from "../types";

interface TagDetailViewProps {
  models: STLModel[];
  tagName: string;
  onOpenMobileSidebar?: () => void;
  onBack: () => void;
  onOpenModel: (model: STLModel) => void;
  onOpenInLibrary: (tag: string) => void;
  onRenameTag: (oldTag: string, newTag: string) => Promise<void>;
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

const FORMAT_COLORS: Record<string, string> = {
  STL: "oklch(var(--accent) / 0.8)",
  "3MF": "oklch(0.7 0.14 200 / 0.8)",
  STEP: "oklch(0.72 0.13 150 / 0.8)",
  STP: "oklch(0.72 0.13 150 / 0.8)",
};

const TagDetailView: React.FC<TagDetailViewProps> = ({
  models,
  tagName,
  onOpenMobileSidebar,
  onBack,
  onOpenModel,
  onOpenInLibrary,
  onRenameTag,
}) => {
  const navigate = useNavigate();
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(tagName);
  const [renameBusy, setRenameBusy] = useState(false);

  const tagged = useMemo(
    () => models.filter((m) => m.tags.includes(tagName)),
    [models, tagName],
  );

  const stats = useMemo(() => {
    if (tagged.length === 0) {
      return { totalSize: 0, latest: null as number | null, earliest: null as number | null };
    }
    let totalSize = 0;
    let latest = -Infinity;
    let earliest = Infinity;
    for (const m of tagged) {
      totalSize += m.size;
      if (m.dateAdded > latest) latest = m.dateAdded;
      if (m.dateAdded < earliest) earliest = m.dateAdded;
    }
    return { totalSize, latest, earliest };
  }, [tagged]);

  const formatBreakdown = useMemo(() => {
    const counts = new Map<string, number>();
    for (const m of tagged) {
      const ext = extOf(m.name) || "OTHER";
      counts.set(ext, (counts.get(ext) ?? 0) + 1);
    }
    const total = tagged.length || 1;
    const entries = Array.from(counts.entries())
      .map(([fmt, count]) => ({ fmt, count, pct: (count / total) * 100 }))
      .sort((a, b) => b.count - a.count);
    return entries;
  }, [tagged]);

  const relatedTags = useMemo(() => {
    const counts = new Map<string, number>();
    for (const m of tagged) {
      for (const t of m.tags) {
        if (t === tagName) continue;
        counts.set(t, (counts.get(t) ?? 0) + 1);
      }
    }
    return Array.from(counts.entries())
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
      .slice(0, 12);
  }, [tagged, tagName]);

  const sortedModels = useMemo(
    () => [...tagged].sort((a, b) => b.dateAdded - a.dateAdded),
    [tagged],
  );

  const handleRenameSubmit = async () => {
    const next = renameValue.trim();
    if (!next || next === tagName) {
      setIsRenaming(false);
      setRenameValue(tagName);
      return;
    }
    setRenameBusy(true);
    try {
      await onRenameTag(tagName, next);
      navigate(`/tags/${encodeURIComponent(next)}`, { replace: true });
    } catch (err) {
      console.error("Tag rename failed:", err);
      alert("Tag rename failed. See console.");
    } finally {
      setRenameBusy(false);
      setIsRenaming(false);
    }
  };

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
          onClick={() => navigate("/tags")}
          className="hidden md:inline-flex items-center gap-1.5 px-2 py-1.5 -ml-1 rounded-md text-fg-2 hover:bg-bg-3 hover:text-fg transition-colors text-[13px]"
        >
          <ChevronLeft size={16} />
          Tags
        </button>
        <h1 className="text-[16px] md:text-[22px] font-semibold -tracking-[0.02em] text-fg truncate">
          <span className="text-fg-3 font-mono mr-1">#</span>
          {tagName}
        </h1>
      </header>

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-[1040px] mx-auto w-full px-4 md:px-7 py-7">
          <button
            type="button"
            onClick={onBack}
            className="md:hidden inline-flex items-center gap-1.5 mb-4 -ml-1 px-2 py-1.5 rounded-md text-fg-2 hover:bg-bg-3 hover:text-fg transition-colors text-[13px]"
          >
            <ChevronLeft size={16} />
            All tags
          </button>

          <div className="rounded-[14px] border border-border-soft bg-surface p-5 md:p-7 mb-7">
            <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-5">
              <div className="min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <span className="font-mono text-fg-3 text-[16px]">#</span>
                  {isRenaming ? (
                    <input
                      autoFocus
                      type="text"
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") handleRenameSubmit();
                        if (e.key === "Escape") {
                          setIsRenaming(false);
                          setRenameValue(tagName);
                        }
                      }}
                      disabled={renameBusy}
                      className="text-[26px] md:text-[30px] font-semibold -tracking-[0.02em] text-fg bg-bg-2 border border-accent rounded-md px-2 py-0.5 min-w-0 max-w-full focus:outline-none disabled:opacity-60"
                    />
                  ) : (
                    <h2 className="text-[26px] md:text-[30px] font-semibold -tracking-[0.02em] text-fg m-0 truncate">
                      {tagName}
                    </h2>
                  )}
                </div>
                <div className="font-mono text-[12px] text-fg-3 flex items-center gap-2 flex-wrap">
                  <span>
                    {tagged.length} model{tagged.length === 1 ? "" : "s"}
                  </span>
                  {tagged.length > 0 && (
                    <>
                      <span className="w-0.5 h-0.5 bg-current rounded-full" />
                      <span>{formatSize(stats.totalSize)} total</span>
                      <span className="w-0.5 h-0.5 bg-current rounded-full" />
                      <span>
                        latest{" "}
                        {stats.latest != null
                          ? new Date(stats.latest).toLocaleDateString()
                          : "—"}
                      </span>
                    </>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2">
                {isRenaming ? (
                  <>
                    <button
                      type="button"
                      onClick={handleRenameSubmit}
                      disabled={renameBusy}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-accent text-accent-fg text-[13px] font-medium hover:opacity-90 disabled:opacity-60 transition-opacity"
                    >
                      <Check size={14} />
                      {renameBusy ? "Saving…" : "Save"}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setIsRenaming(false);
                        setRenameValue(tagName);
                      }}
                      disabled={renameBusy}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-border-soft text-fg-2 text-[13px] hover:bg-bg-3 hover:text-fg disabled:opacity-60 transition-colors"
                    >
                      <X size={14} />
                      Cancel
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={() => setIsRenaming(true)}
                      disabled={tagged.length === 0}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-border-soft text-fg-2 text-[13px] hover:bg-bg-3 hover:text-fg disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                    >
                      <Pencil size={14} />
                      Rename
                    </button>
                    <button
                      type="button"
                      onClick={() => onOpenInLibrary(tagName)}
                      disabled={tagged.length === 0}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-accent text-accent-fg text-[13px] font-medium hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-opacity"
                    >
                      <ExternalLink size={14} />
                      Open in library
                    </button>
                  </>
                )}
              </div>
            </div>

            {tagged.length > 0 && (
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mt-6 pt-5 border-t border-border-soft">
                <div>
                  <div className="font-mono text-[10.5px] uppercase tracking-wider text-fg-3 mb-2">
                    Formats
                  </div>
                  <div className="flex flex-col gap-1.5">
                    {formatBreakdown.map(({ fmt, count, pct }) => (
                      <div key={fmt} className="flex items-center gap-2">
                        <span className="font-mono text-[10.5px] text-fg-3 w-9 shrink-0">
                          {fmt}
                        </span>
                        <div className="flex-1 h-[6px] bg-bg-3 rounded-full overflow-hidden">
                          <div
                            className="h-full rounded-full"
                            style={{
                              width: `${pct}%`,
                              background:
                                FORMAT_COLORS[fmt] ||
                                "oklch(var(--fg-3) / 0.6)",
                            }}
                          />
                        </div>
                        <span className="font-mono text-[10.5px] text-fg-3 w-6 text-right shrink-0">
                          {count}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
                <div>
                  <div className="font-mono text-[10.5px] uppercase tracking-wider text-fg-3 mb-2">
                    Total size
                  </div>
                  <div className="text-[20px] font-semibold -tracking-[0.01em] text-fg">
                    {formatSize(stats.totalSize)}
                  </div>
                </div>
                <div>
                  <div className="font-mono text-[10.5px] uppercase tracking-wider text-fg-3 mb-2">
                    Date range
                  </div>
                  <div className="text-[13px] text-fg-2">
                    {stats.earliest != null && stats.latest != null
                      ? stats.earliest === stats.latest
                        ? new Date(stats.earliest).toLocaleDateString()
                        : `${new Date(stats.earliest).toLocaleDateString()} → ${new Date(stats.latest).toLocaleDateString()}`
                      : "—"}
                  </div>
                </div>
              </div>
            )}
          </div>

          {relatedTags.length > 0 && (
            <section className="mb-7">
              <h3 className="m-0 mb-3 text-[14px] font-semibold -tracking-[0.005em] text-fg">
                Related tags
              </h3>
              <div className="flex flex-wrap gap-2">
                {relatedTags.map(({ tag, count }) => (
                  <button
                    key={tag}
                    type="button"
                    onClick={() => navigate(`/tags/${encodeURIComponent(tag)}`)}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-pill border border-border-soft bg-surface hover:border-border hover:bg-bg-3 transition-colors"
                  >
                    <span className="font-mono text-fg-3 text-[11px]">#</span>
                    <span className="text-[13px] text-fg">{tag}</span>
                    <span className="font-mono text-[10.5px] text-fg-3">
                      {count}
                    </span>
                  </button>
                ))}
              </div>
            </section>
          )}

          {tagged.length === 0 ? (
            <div className="rounded-[10px] border border-border-soft bg-surface px-6 py-12 text-center">
              <div className="text-[15px] font-medium text-fg">
                No models with this tag
              </div>
              <div className="text-[13px] text-fg-3 mt-1">
                It may have been removed since the page loaded.
              </div>
            </div>
          ) : (
            <section>
              <h3 className="m-0 mb-3 text-[14px] font-semibold -tracking-[0.005em] text-fg">
                Models
              </h3>
              <div className="flex flex-col gap-1.5">
                {sortedModels.map((m) => (
                  <TagModelRow
                    key={m.id}
                    model={m}
                    onOpen={() => onOpenModel(m)}
                  />
                ))}
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
};

const TagModelRow: React.FC<{ model: STLModel; onOpen: () => void }> = ({
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
          <span>{new Date(model.dateAdded).toLocaleDateString()}</span>
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

export default TagDetailView;
