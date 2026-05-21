import React, { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Menu as MenuIcon, ChevronLeft, Search, Tag as TagIcon } from "lucide-react";
import { STLModel } from "../types";

interface TagsViewProps {
  models: STLModel[];
  onOpenMobileSidebar?: () => void;
  onBack: () => void;
}

type SortMode = "count" | "name";

const TagsView: React.FC<TagsViewProps> = ({
  models,
  onOpenMobileSidebar,
  onBack,
}) => {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [sortMode, setSortMode] = useState<SortMode>("count");

  const { tagCounts, taggedCount, untaggedCount } = useMemo(() => {
    const counts = new Map<string, number>();
    let tagged = 0;
    let untagged = 0;
    for (const m of models) {
      if (m.tags.length > 0) {
        tagged++;
        for (const t of m.tags) {
          counts.set(t, (counts.get(t) ?? 0) + 1);
        }
      } else {
        untagged++;
      }
    }
    return { tagCounts: counts, taggedCount: tagged, untaggedCount: untagged };
  }, [models]);

  const maxCount = useMemo(() => {
    let max = 1;
    tagCounts.forEach((v) => {
      if (v > max) max = v;
    });
    return max;
  }, [tagCounts]);

  const visibleTags = useMemo(() => {
    const q = query.trim().toLowerCase();
    const arr: { tag: string; count: number }[] = [];
    tagCounts.forEach((count, tag) => {
      if (!q || tag.toLowerCase().includes(q)) arr.push({ tag, count });
    });
    arr.sort((a, b) => {
      if (sortMode === "count") {
        if (b.count !== a.count) return b.count - a.count;
        return a.tag.localeCompare(b.tag);
      }
      return a.tag.localeCompare(b.tag);
    });
    return arr;
  }, [tagCounts, query, sortMode]);

  const isEmpty = tagCounts.size === 0;

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
        <h1 className="text-[17px] md:text-[18px] font-medium -tracking-[0.01em] text-fg">
          Tags
        </h1>
      </header>

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-[1040px] mx-auto w-full px-4 md:px-7 py-7">
          <div className="mb-8 pb-6 border-b border-border-soft">
            <h2 className="text-[28px] font-semibold -tracking-[0.02em] text-fg m-0">
              Tags
            </h2>
            <p className="text-fg-3 text-[13.5px] mt-1.5 max-w-[480px]">
              Every label you've put on a model — sorted by usage by default.
            </p>
            <div className="grid grid-cols-3 gap-3 mt-5 max-w-[520px]">
              {[
                { label: "Tags", value: tagCounts.size },
                { label: "Tagged", value: taggedCount },
                { label: "Untagged", value: untaggedCount },
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

          {isEmpty ? (
            <div className="rounded-[10px] border border-border-soft bg-surface px-6 py-12 text-center">
              <TagIcon size={28} className="text-fg-3 mx-auto" />
              <div className="text-[15px] font-medium text-fg mt-3">
                No tags yet
              </div>
              <div className="text-[13px] text-fg-3 mt-1">
                Add tags to a model from its detail panel and they'll show up
                here.
              </div>
            </div>
          ) : (
            <>
              <div className="flex flex-col sm:flex-row sm:items-center gap-3 mb-5">
                <div className="relative flex-1 max-w-[420px]">
                  <Search
                    size={14}
                    className="absolute left-3 top-1/2 -translate-y-1/2 text-fg-3"
                  />
                  <input
                    type="text"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search tags…"
                    className="w-full bg-surface border border-border-soft rounded-md pl-9 pr-3 py-2 text-[13px] text-fg placeholder:text-fg-3 focus:outline-none focus:border-accent transition-colors"
                  />
                </div>
                <div className="inline-flex bg-bg-3 rounded-lg p-[3px] gap-0.5 self-start">
                  {(["count", "name"] as SortMode[]).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => setSortMode(mode)}
                      className={`px-3 py-1 rounded-md text-[12.5px] transition-all ${
                        sortMode === mode
                          ? "bg-surface text-fg shadow-soft"
                          : "text-fg-3 hover:text-fg"
                      }`}
                      aria-pressed={sortMode === mode}
                    >
                      {mode === "count" ? "Most used" : "A → Z"}
                    </button>
                  ))}
                </div>
              </div>

              {visibleTags.length === 0 ? (
                <div className="text-[13px] text-fg-3 px-2 py-8 text-center">
                  No tags match "{query}".
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                  {visibleTags.map(({ tag, count }) => {
                    const widthPct = (count / maxCount) * 100;
                    return (
                      <button
                        key={tag}
                        type="button"
                        onClick={() =>
                          navigate(`/tags/${encodeURIComponent(tag)}`)
                        }
                        className="text-left p-4 rounded-[10px] border border-border-soft bg-surface hover:border-border hover:-translate-y-px transition-all"
                      >
                        <div className="flex items-center justify-between gap-3">
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="font-mono text-fg-3 text-[13px]">
                              #
                            </span>
                            <span className="text-[14px] font-medium text-fg truncate">
                              {tag}
                            </span>
                          </div>
                          <span className="font-mono text-[11px] text-fg-3 shrink-0">
                            {count}
                          </span>
                        </div>
                        <div className="mt-3 h-[3px] rounded-full bg-bg-3 overflow-hidden">
                          <div
                            className="h-full bg-accent/70 rounded-full"
                            style={{ width: `${Math.max(widthPct, 3)}%` }}
                          />
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default TagsView;
