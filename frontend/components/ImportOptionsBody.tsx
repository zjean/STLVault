import React, { useMemo } from "react";
import { Check, FileBox } from "lucide-react";
import { STLModelCollection } from "../types";

interface Props {
  modelsOptions: STLModelCollection[];
  selectedOptions: Set<string>;
  onToggle: (id: string) => void;
  onSelectAll: () => void;
  onClearAll: () => void;
  onCancel: () => void;
  onImport: () => void;
}

const ImportOptionsBody: React.FC<Props> = ({
  modelsOptions,
  selectedOptions,
  onToggle,
  onSelectAll,
  onClearAll,
  onCancel,
  onImport,
}) => {
  const grouped = useMemo(() => {
    const map = new Map<string, STLModelCollection[]>();
    for (const m of modelsOptions) {
      const key = m.folder ?? "";
      const bucket = map.get(key);
      if (bucket) bucket.push(m);
      else map.set(key, [m]);
    }
    return Array.from(map.entries()).map(([folder, items]) => ({
      folder,
      items,
    }));
  }, [modelsOptions]);

  const total = modelsOptions.length;
  const selectedCount = selectedOptions.size;
  const allSelected = total > 0 && selectedCount === total;

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="flex items-center justify-between px-5 py-2.5 border-b border-border-soft bg-bg-2">
        <span className="text-[12.5px] text-fg-3">
          {total} {total === 1 ? "file" : "files"} ·{" "}
          <span className="text-fg">
            {selectedCount} selected
          </span>
        </span>
        <button
          type="button"
          onClick={allSelected ? onClearAll : onSelectAll}
          disabled={total === 0}
          className="text-[12.5px] text-fg-2 hover:text-fg disabled:opacity-50 transition-colors"
        >
          {allSelected ? "Clear all" : "Select all"}
        </button>
      </div>

      <div className="px-4 py-3 overflow-y-auto flex-1 min-h-0">
        {grouped.length === 0 ? (
          <div className="text-[13px] text-fg-3 text-center py-8">
            No files found at this URL.
          </div>
        ) : (
          grouped.map(({ folder, items }) => (
            <section key={folder || "__root__"} className="mb-4 last:mb-0">
              <div className="px-1 mb-2 text-[11px] font-mono uppercase tracking-wider text-fg-3">
                {folder || "Root"}
              </div>
              <div className="flex flex-col gap-1.5">
                {items.map((model) => {
                  const isSelected = selectedOptions.has(model.id);
                  return (
                    <button
                      key={model.id}
                      type="button"
                      onClick={() => onToggle(model.id)}
                      className={`text-left flex items-center gap-3 px-3 py-2 rounded-card border transition-colors ${
                        isSelected
                          ? "border-accent bg-accent/5"
                          : "border-border-soft bg-surface hover:border-border"
                      }`}
                    >
                      <span
                        className={`w-[18px] h-[18px] rounded-full grid place-items-center border-[1.5px] shrink-0 transition-colors ${
                          isSelected
                            ? "border-accent bg-accent text-accent-fg"
                            : "border-border bg-transparent text-transparent"
                        }`}
                        aria-hidden
                      >
                        <Check size={11} />
                      </span>
                      <div
                        className="h-9 w-11 rounded-md border border-border-soft grid place-items-center overflow-hidden shrink-0"
                        style={{
                          background:
                            "radial-gradient(ellipse at 50% 100%, oklch(var(--accent) / 0.08), transparent 60%), linear-gradient(180deg, oklch(var(--bg-2)), oklch(var(--bg-3)))",
                        }}
                      >
                        {model.previewPath ? (
                          <img
                            src={model.previewPath}
                            alt=""
                            className="h-full w-full object-contain"
                            loading="lazy"
                          />
                        ) : (
                          <FileBox size={16} className="text-fg-3" />
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="text-[13.5px] font-medium text-fg truncate">
                          {model.name}
                        </div>
                        <div className="font-mono text-[11px] text-fg-3 truncate">
                          {model.typeName}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </section>
          ))
        )}
      </div>

      <div className="flex items-center justify-end gap-2 px-5 py-3.5 border-t border-border-soft">
        <button
          type="button"
          onClick={onCancel}
          className="px-3.5 py-1.5 rounded-md border border-border-soft text-fg-2 text-[13px] hover:bg-bg-3 hover:text-fg transition-colors"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onImport}
          disabled={selectedCount === 0}
          className="px-3.5 py-1.5 rounded-md bg-accent text-accent-fg text-[13px] font-medium hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-opacity"
        >
          Import {selectedCount > 0 ? `(${selectedCount})` : ""}
        </button>
      </div>
    </div>
  );
};

export default ImportOptionsBody;
