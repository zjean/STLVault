import React, { useRef, useState, useMemo, useEffect } from "react";
import {
  CloudUpload,
  FileBox,
  Search,
  MoreHorizontal,
  Download,
  Globe,
  Folder as FolderIcon,
  ChevronLeft,
  Heart,
  Menu as MenuIcon,
  X,
  CheckSquare,
  Square,
  LayoutGrid,
  List as ListIcon,
  Check,
  Trash2,
  ExternalLink,
} from "lucide-react";
import { STLModel, Folder } from "../types";
import { api } from "../services/api";

interface ModelListProps {
  models: STLModel[];
  folders: Folder[];
  currentFolderName: string;
  onBackNavigation: () => void;
  onUpload: (files: FileList) => void;
  onImport: () => void;
  onBrowseLiked?: () => void;
  onSelectModel: (model: STLModel) => void;
  onDelete: (id: string) => void;
  selectedModelId: string | null;

  // Selection
  selectedIds: Set<string>;
  onToggleSelection: (id: string) => void;
  onSelectAll: (filtered: STLModel[]) => void;
  onClearSelection: () => void;

  // Folder
  onNavigateFolder: (id: string) => void;
  onMoveToFolder: (folderId: string, modelIds: string[]) => void;
  onUploadToFolder: (folderId: string, files: FileList) => void;

  // Mobile shell
  onOpenMobileSidebar?: () => void;
}

type SortOption =
  | "date-desc"
  | "date-asc"
  | "name-asc"
  | "name-desc"
  | "size-desc"
  | "size-asc";
type ViewMode = "grid" | "list";

const SORT_LABELS: Record<SortOption, string> = {
  "date-desc": "Date added (newest)",
  "date-asc": "Date added (oldest)",
  "name-asc": "Name (A → Z)",
  "name-desc": "Name (Z → A)",
  "size-desc": "Size (largest)",
  "size-asc": "Size (smallest)",
};

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

const ModelList: React.FC<ModelListProps> = ({
  models,
  folders,
  currentFolderName,
  onBackNavigation,
  onUpload,
  onImport,
  onBrowseLiked,
  onSelectModel,
  onDelete,
  selectedModelId,
  selectedIds,
  onToggleSelection,
  onSelectAll,
  onClearSelection,
  onNavigateFolder,
  onMoveToFolder,
  onUploadToFolder,
  onOpenMobileSidebar,
}) => {
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [sortBy, setSortBy] = useState<SortOption>("date-desc");
  const [viewMode, setViewMode] = useState<ViewMode>("grid");
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [dragOverFolderId, setDragOverFolderId] = useState<string | null>(null);

  useEffect(() => {
    if (!openMenuId) return;
    const close = () => setOpenMenuId(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [openMenuId]);

  const processedModels = useMemo(() => {
    let result = [...models];
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      result = result.filter(
        (m) =>
          m.name.toLowerCase().includes(query) ||
          m.tags.some((t) => t.toLowerCase().includes(query)) ||
          (m.description || "").toLowerCase().includes(query),
      );
    }
    result.sort((a, b) => {
      switch (sortBy) {
        case "date-desc":
          return b.dateAdded - a.dateAdded;
        case "date-asc":
          return a.dateAdded - b.dateAdded;
        case "name-asc":
          return a.name.localeCompare(b.name);
        case "name-desc":
          return b.name.localeCompare(a.name);
        case "size-desc":
          return b.size - a.size;
        case "size-asc":
          return a.size - b.size;
        default:
          return 0;
      }
    });
    return result;
  }, [models, searchQuery, sortBy]);

  const processedFolders = useMemo(() => {
    let result = [...folders];
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      result = result.filter((f) => f.name.toLowerCase().includes(query));
    }
    result.sort((a, b) => a.name.localeCompare(b.name));
    return result;
  }, [folders, searchQuery]);

  // Drag-drop for upload onto the grid area
  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer.types.includes("Files")) setIsDragging(true);
  };
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };
  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    setIsDragging(false);
  };
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      onUpload(e.dataTransfer.files);
    }
  };

  const handleFolderDrop = (e: React.DragEvent, folderId: string) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOverFolderId(null);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      onUploadToFolder(folderId, e.dataTransfer.files);
      return;
    }
    try {
      const data = e.dataTransfer.getData("application/json");
      if (data) {
        const { modelIds } = JSON.parse(data);
        if (Array.isArray(modelIds) && modelIds.length > 0) {
          onMoveToFolder(folderId, modelIds);
        }
      }
    } catch (err) {
      console.error("Failed to process drop on folder", err);
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) onUpload(e.target.files);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleCardDragStart = (e: React.DragEvent, modelId: string) => {
    const idsToMove = selectedIds.has(modelId)
      ? Array.from(selectedIds)
      : [modelId];
    e.dataTransfer.setData(
      "application/json",
      JSON.stringify({ modelIds: idsToMove }),
    );
    e.dataTransfer.effectAllowed = "move";
  };

  const selectionMode = selectedIds.size > 0;
  const allSelected =
    processedModels.length > 0 && selectedIds.size === processedModels.length;

  const isRootView = currentFolderName === "All Models";

  return (
    <div className="flex-1 min-w-0 flex flex-col overflow-hidden bg-bg">
      {/* === Main header === */}
      <header className="px-4 py-3.5 md:px-7 md:py-4 border-b border-border-soft flex items-center gap-3 md:gap-4 flex-wrap">
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
        <div className="flex items-baseline gap-2 min-w-0">
          <h1 className="text-[17px] md:text-[18px] font-medium -tracking-[0.01em] text-fg truncate">
            {currentFolderName}
          </h1>
          <span className="hidden sm:inline-flex font-mono text-[12px] text-fg-3 bg-bg-3 px-2 py-0.5 rounded-pill">
            {processedFolders.length} folders · {processedModels.length} models
            {models.length !== processedModels.length &&
              ` (filtered from ${models.length})`}
          </span>
        </div>
        <div className="flex-1" />
        <div className="flex items-center gap-1.5 md:gap-2">
          <button
            type="button"
            onClick={onImport}
            className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-border bg-surface hover:bg-surface-2 hover:border-fg-3 text-[13px] font-medium text-fg transition-colors"
          >
            <Globe size={15} />
            <span className="hidden sm:inline">Import URL</span>
          </button>
          {onBrowseLiked && (
            <button
              type="button"
              onClick={onBrowseLiked}
              className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-border bg-surface hover:bg-surface-2 hover:border-fg-3 text-[13px] font-medium text-fg transition-colors"
            >
              <Heart size={15} />
              <span className="hidden sm:inline">Browse Liked</span>
            </button>
          )}
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-transparent bg-accent text-accent-fg hover:brightness-105 text-[13px] font-semibold transition-all"
          >
            <CloudUpload size={15} />
            <span className="hidden sm:inline">Upload</span>
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".stl,.step,.stp,.3mf"
            multiple
            onChange={handleFileSelect}
            className="hidden"
          />
        </div>
      </header>

      {/* === Toolbar === */}
      <div className="px-4 py-4 md:px-7 flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[200px]">
          <Search
            size={15}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-fg-3 pointer-events-none"
          />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search models, tags, descriptions…"
            className="w-full pl-10 pr-9 py-2.5 bg-surface border border-border rounded-[10px] text-[13px] text-fg placeholder:text-fg-3 outline-none focus:border-accent focus:ring-[3px] focus:ring-accent/15 transition-all"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 w-6 h-6 grid place-items-center rounded text-fg-3 hover:bg-bg-3 hover:text-fg"
              aria-label="Clear search"
            >
              <X size={14} />
            </button>
          )}
        </div>

        <div className="relative">
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as SortOption)}
            className="appearance-none pl-3 pr-8 py-2 bg-surface border border-border rounded-lg text-[13px] text-fg cursor-pointer outline-none focus:border-accent focus:ring-[3px] focus:ring-accent/15 transition-all"
            style={{
              backgroundImage:
                "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23999' stroke-width='2'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E\")",
              backgroundRepeat: "no-repeat",
              backgroundPosition: "right 10px center",
            }}
          >
            {Object.entries(SORT_LABELS).map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </select>
        </div>

        <div className="inline-flex bg-bg-3 rounded-lg p-[3px] gap-0.5">
          <button
            type="button"
            onClick={() => setViewMode("grid")}
            className={`px-2.5 py-1.5 rounded-md grid place-items-center transition-all ${
              viewMode === "grid"
                ? "bg-surface text-fg shadow-soft"
                : "text-fg-3 hover:text-fg"
            }`}
            aria-label="Grid view"
            aria-pressed={viewMode === "grid"}
          >
            <LayoutGrid size={14} />
          </button>
          <button
            type="button"
            onClick={() => setViewMode("list")}
            className={`px-2.5 py-1.5 rounded-md grid place-items-center transition-all ${
              viewMode === "list"
                ? "bg-surface text-fg shadow-soft"
                : "text-fg-3 hover:text-fg"
            }`}
            aria-label="List view"
            aria-pressed={viewMode === "list"}
          >
            <ListIcon size={14} />
          </button>
        </div>
      </div>

      {/* === Grid wrap === */}
      <div
        className={`flex-1 overflow-y-auto px-4 md:px-7 pb-10 ${
          viewMode === "list" ? "list-mode" : ""
        }`}
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {/* Back button */}
        {!isRootView && (
          <button
            type="button"
            onClick={onBackNavigation}
            className="inline-flex items-center gap-1.5 px-2 py-1.5 mt-1 mb-2 -ml-2 rounded-md text-[13px] text-fg-2 hover:bg-bg-3 hover:text-fg transition-colors"
          >
            <ChevronLeft size={16} />
            Back
          </button>
        )}

        {/* Selection bar */}
        {selectionMode && (
          <div className="sticky top-0 z-[5] my-2 px-3.5 py-2.5 rounded-[10px] bg-accent/15 border border-accent/40 flex items-center gap-2.5 text-accent font-medium text-[13px] backdrop-blur">
            <CheckSquare size={15} />
            <span>{selectedIds.size} selected</span>
            <div className="ml-auto flex gap-1.5">
              <button
                type="button"
                onClick={() =>
                  allSelected
                    ? onClearSelection()
                    : onSelectAll(processedModels)
                }
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[12px] text-accent hover:bg-accent/15"
              >
                {allSelected ? "Clear" : `Select all ${processedModels.length}`}
              </button>
              <button
                type="button"
                onClick={onClearSelection}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[12px] text-accent hover:bg-accent/15"
                aria-label="Close selection"
              >
                <X size={14} />
              </button>
            </div>
          </div>
        )}

        {/* Empty state */}
        {processedModels.length === 0 && processedFolders.length === 0 ? (
          <div
            className={`mt-2 border-[1.5px] border-dashed border-border rounded-card py-14 px-6 text-center flex flex-col items-center gap-4 text-fg-3 ${
              isDragging ? "border-accent bg-accent/10" : ""
            }`}
          >
            <div className="w-14 h-14 rounded-card bg-bg-3 grid place-items-center">
              {searchQuery ? (
                <Search size={26} />
              ) : (
                <FileBox size={26} />
              )}
            </div>
            <div>
              <h3 className="text-[15px] text-fg-2 font-medium m-0">
                {searchQuery ? "No matches found" : "This folder is empty"}
              </h3>
              <p className="text-[13px] max-w-[320px] mt-1.5">
                {searchQuery
                  ? "Try adjusting your search query."
                  : "Drag and drop STL, STEP, or 3MF files to upload."}
              </p>
            </div>
            {!searchQuery && (
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg bg-accent text-accent-fg text-[13px] font-semibold hover:brightness-105 transition-all"
              >
                <CloudUpload size={15} /> Choose files
              </button>
            )}
          </div>
        ) : viewMode === "grid" ? (
          // === GRID VIEW ===
          <>
            {/* Folders */}
            {processedFolders.length > 0 && (
              <div className="grid gap-3 pb-4 pt-1 grid-cols-[repeat(auto-fill,minmax(200px,1fr))]">
                {processedFolders.map((folder) => (
                  <button
                    type="button"
                    key={folder.id}
                    onClick={() => onNavigateFolder(folder.id)}
                    onDragOver={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setDragOverFolderId(folder.id);
                    }}
                    onDragLeave={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setDragOverFolderId(null);
                    }}
                    onDrop={(e) => handleFolderDrop(e, folder.id)}
                    className={`group flex items-center gap-3 px-3.5 py-3 rounded-card bg-surface border text-left transition-all ${
                      dragOverFolderId === folder.id
                        ? "border-accent ring-2 ring-accent/40"
                        : "border-border-soft hover:border-border hover:-translate-y-px hover:shadow-lifted"
                    }`}
                  >
                    <div className="w-9 h-9 rounded-md bg-bg-3 grid place-items-center text-fg-2 shrink-0">
                      <FolderIcon size={18} />
                    </div>
                    <div className="min-w-0">
                      <div className="text-[13.5px] font-medium text-fg truncate">
                        {folder.name}
                      </div>
                      <div className="text-[11px] text-fg-3 font-mono">
                        Folder
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            )}

            {/* Model grid */}
            <div className="grid gap-4 pt-2 pb-4 grid-cols-[repeat(auto-fill,minmax(220px,1fr))]">
              {processedModels.map((model) => {
                const isSelected = selectedIds.has(model.id);
                return (
                  <ModelCardGrid
                    key={model.id}
                    model={model}
                    isSelected={isSelected}
                    selectionMode={selectionMode}
                    isActiveDetail={selectedModelId === model.id}
                    menuOpen={openMenuId === model.id}
                    onToggleMenu={() =>
                      setOpenMenuId((id) => (id === model.id ? null : model.id))
                    }
                    onClick={() => {
                      if (selectionMode) onToggleSelection(model.id);
                      else onSelectModel(model);
                    }}
                    onToggleSelection={() => onToggleSelection(model.id)}
                    onDelete={() => onDelete(model.id)}
                    onDragStart={(e) => handleCardDragStart(e, model.id)}
                  />
                );
              })}
            </div>
          </>
        ) : (
          // === LIST VIEW ===
          <>
            {processedFolders.length > 0 && (
              <div className="flex flex-col gap-1 pt-1 pb-3">
                {processedFolders.map((folder) => (
                  <button
                    type="button"
                    key={folder.id}
                    onClick={() => onNavigateFolder(folder.id)}
                    onDragOver={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setDragOverFolderId(folder.id);
                    }}
                    onDragLeave={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setDragOverFolderId(null);
                    }}
                    onDrop={(e) => handleFolderDrop(e, folder.id)}
                    className={`grid grid-cols-[40px_1fr_auto] items-center gap-3.5 px-3.5 py-2 rounded-lg bg-surface border text-left transition-all ${
                      dragOverFolderId === folder.id
                        ? "border-accent ring-2 ring-accent/40"
                        : "border-border-soft hover:border-border"
                    }`}
                  >
                    <div className="w-9 h-9 rounded-md bg-bg-3 grid place-items-center text-fg-2">
                      <FolderIcon size={18} />
                    </div>
                    <div className="min-w-0">
                      <div className="text-[13.5px] font-medium text-fg truncate">
                        {folder.name}
                      </div>
                    </div>
                    <span className="font-mono text-[10.5px] text-fg-3 bg-bg-3 px-1.5 py-0.5 rounded">
                      Folder
                    </span>
                  </button>
                ))}
              </div>
            )}

            <div className="flex flex-col gap-2 pt-1 pb-4">
              {processedModels.map((model) => {
                const isSelected = selectedIds.has(model.id);
                return (
                  <ModelCardList
                    key={model.id}
                    model={model}
                    isSelected={isSelected}
                    selectionMode={selectionMode}
                    isActiveDetail={selectedModelId === model.id}
                    menuOpen={openMenuId === model.id}
                    onToggleMenu={() =>
                      setOpenMenuId((id) => (id === model.id ? null : model.id))
                    }
                    onClick={() => {
                      if (selectionMode) onToggleSelection(model.id);
                      else onSelectModel(model);
                    }}
                    onToggleSelection={() => onToggleSelection(model.id)}
                    onDelete={() => onDelete(model.id)}
                    onDragStart={(e) => handleCardDragStart(e, model.id)}
                  />
                );
              })}
            </div>
          </>
        )}
      </div>

      {/* Drop overlay */}
      {isDragging && (
        <div className="absolute inset-0 z-[40] grid place-items-center bg-accent/10 border-[3px] border-dashed border-accent pointer-events-none">
          <div className="bg-surface px-6 py-5 rounded-xl shadow-drawer border border-border flex items-center gap-3">
            <CloudUpload size={22} className="text-accent" />
            <div>
              <div className="text-[15px] font-medium text-fg">
                Drop to upload
              </div>
              <div className="text-[12px] text-fg-3 font-mono">
                STL · STEP · 3MF
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

interface CardProps {
  model: STLModel;
  isSelected: boolean;
  isActiveDetail: boolean;
  selectionMode: boolean;
  menuOpen: boolean;
  onToggleMenu: () => void;
  onClick: () => void;
  onToggleSelection: () => void;
  onDelete: () => void;
  onDragStart: (e: React.DragEvent) => void;
}

const ModelCardGrid: React.FC<CardProps> = ({
  model,
  isSelected,
  isActiveDetail,
  selectionMode,
  menuOpen,
  onToggleMenu,
  onClick,
  onToggleSelection,
  onDelete,
  onDragStart,
}) => {
  const ext = extOf(model.name);
  return (
    <div
      role="button"
      tabIndex={0}
      draggable
      onDragStart={onDragStart}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
      className={`group/card relative flex flex-col rounded-card overflow-hidden bg-surface border transition-all cursor-pointer ${
        isSelected || isActiveDetail
          ? "border-accent shadow-[0_0_0_1px_oklch(var(--accent)),0_8px_24px_oklch(0_0_0/0.35)]"
          : "border-border-soft hover:border-border hover:-translate-y-px hover:shadow-lifted"
      }`}
    >
      <div
        className="relative h-[160px] grid place-items-center border-b border-border-soft overflow-hidden"
        style={{
          background:
            "radial-gradient(ellipse at 50% 100%, oklch(var(--accent) / 0.08), transparent 60%), linear-gradient(180deg, oklch(var(--bg-2)), oklch(var(--bg-3)))",
        }}
      >
        <div
          className="absolute inset-0 opacity-100"
          style={{
            backgroundImage:
              "linear-gradient(oklch(var(--fg) / 0.025) 1px, transparent 1px), linear-gradient(90deg, oklch(var(--fg) / 0.025) 1px, transparent 1px)",
            backgroundSize: "24px 24px",
            maskImage:
              "radial-gradient(ellipse at center, black 30%, transparent 75%)",
            WebkitMaskImage:
              "radial-gradient(ellipse at center, black 30%, transparent 75%)",
          }}
        />
        {model.thumbnail ? (
          <img
            src={model.thumbnail}
            alt=""
            className="relative h-full w-full object-cover"
          />
        ) : (
          <FileBox
            size={52}
            className="relative text-fg-3"
            style={{
              filter:
                "drop-shadow(0 6px 14px oklch(var(--accent) / 0.15))",
            }}
          />
        )}
        {ext && (
          <span className="absolute top-2.5 left-2.5 font-mono text-[10px] font-medium tracking-wide px-1.5 py-0.5 rounded bg-black/55 text-white/90 backdrop-blur">
            {ext}
          </span>
        )}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onToggleSelection();
          }}
          className={`absolute top-2.5 right-2.5 w-[22px] h-[22px] rounded-md grid place-items-center border-[1.5px] backdrop-blur transition-opacity ${
            isSelected || selectionMode
              ? "opacity-100"
              : "opacity-0 group-hover/card:opacity-100"
          } ${
            isSelected
              ? "bg-accent border-accent text-accent-fg"
              : "bg-black/40 border-white/40 text-transparent"
          }`}
          aria-label={isSelected ? "Unselect" : "Select"}
        >
          <Check size={13} className={isSelected ? "" : "opacity-0"} />
        </button>
      </div>

      <div className="px-3.5 py-3 flex flex-col gap-1 flex-1">
        <div className="text-[13.5px] font-medium text-fg truncate -tracking-[0.005em]">
          {model.name}
        </div>
        <div className="font-mono text-[11px] text-fg-3 flex items-center gap-2">
          <span>{formatSize(model.size)}</span>
          <span className="w-0.5 h-0.5 bg-current rounded-full" />
          <span>{new Date(model.dateAdded).toLocaleDateString()}</span>
        </div>
        {model.tags.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-1.5">
            {model.tags.slice(0, 3).map((tag) => (
              <span
                key={tag}
                className="text-[10.5px] px-1.5 py-0.5 rounded bg-bg-3 text-fg-2"
              >
                {tag}
              </span>
            ))}
            {model.tags.length > 3 && (
              <span className="text-[10.5px] px-1.5 py-0.5 rounded bg-bg-3 text-fg-3">
                +{model.tags.length - 3}
              </span>
            )}
          </div>
        )}
      </div>

      <div className="px-3.5 py-2 border-t border-border-soft flex items-center gap-1">
        <a
          href={api.getDownloadUrl(model)}
          onClick={(e) => e.stopPropagation()}
          className="w-7 h-7 grid place-items-center rounded-md text-fg-3 hover:bg-bg-3 hover:text-fg"
          aria-label="Download"
          title="Download"
        >
          <Download size={14} />
        </a>
        <a
          href={api.getSlicerUrl(model)}
          onClick={(e) => e.stopPropagation()}
          className="w-7 h-7 grid place-items-center rounded-md text-fg-3 hover:bg-bg-3 hover:text-fg"
          aria-label="Open in slicer"
          title="Open in slicer"
        >
          <ExternalLink size={14} />
        </a>
        <div className="ml-auto relative">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onToggleMenu();
            }}
            className="w-7 h-7 grid place-items-center rounded-md text-fg-3 hover:bg-bg-3 hover:text-fg"
            aria-label="More actions"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
          >
            <MoreHorizontal size={14} />
          </button>
          {menuOpen && (
            <div
              onClick={(e) => e.stopPropagation()}
              className="absolute bottom-full right-0 mb-1 min-w-[180px] bg-surface border border-border rounded-[10px] shadow-drawer p-1 flex flex-col gap-0.5 z-20"
              role="menu"
            >
              <button
                type="button"
                onClick={() => {
                  onClick();
                  onToggleMenu();
                }}
                className="text-left px-3 py-2 rounded-md text-[13px] text-fg hover:bg-bg-3 flex items-center gap-2.5"
              >
                <ExternalLink size={14} /> Open
              </button>
              <hr className="border-0 border-t border-border-soft my-1" />
              <button
                type="button"
                onClick={() => {
                  onDelete();
                  onToggleMenu();
                }}
                className="text-left px-3 py-2 rounded-md text-[13px] text-danger hover:bg-danger/15 flex items-center gap-2.5"
              >
                <Trash2 size={14} /> Delete
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

const ModelCardList: React.FC<CardProps> = ({
  model,
  isSelected,
  isActiveDetail,
  selectionMode,
  menuOpen,
  onToggleMenu,
  onClick,
  onToggleSelection,
  onDelete,
  onDragStart,
}) => {
  const ext = extOf(model.name);
  return (
    <div
      role="button"
      tabIndex={0}
      draggable
      onDragStart={onDragStart}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
      className={`grid grid-cols-[80px_1fr_auto_auto] items-center gap-3.5 px-3.5 py-2 rounded-card bg-surface border transition-all cursor-pointer ${
        isSelected || isActiveDetail
          ? "border-accent shadow-[0_0_0_1px_oklch(var(--accent)),0_8px_24px_oklch(0_0_0/0.35)]"
          : "border-border-soft hover:border-border"
      }`}
    >
      <div
        className="h-[60px] w-[80px] rounded-md border border-border-soft grid place-items-center overflow-hidden"
        style={{
          background:
            "radial-gradient(ellipse at 50% 100%, oklch(var(--accent) / 0.08), transparent 60%), linear-gradient(180deg, oklch(var(--bg-2)), oklch(var(--bg-3)))",
        }}
      >
        {model.thumbnail ? (
          <img src={model.thumbnail} alt="" className="h-full w-full object-cover" />
        ) : (
          <FileBox size={28} className="text-fg-3" />
        )}
      </div>
      <div className="min-w-0">
        <div className="text-[13.5px] font-medium text-fg truncate">{model.name}</div>
        <div className="font-mono text-[11px] text-fg-3 flex items-center gap-2">
          <span>{formatSize(model.size)}</span>
          <span className="w-0.5 h-0.5 bg-current rounded-full" />
          <span>{new Date(model.dateAdded).toLocaleDateString()}</span>
          {model.tags.length > 0 && (
            <>
              <span className="w-0.5 h-0.5 bg-current rounded-full" />
              <span className="truncate">{model.tags.slice(0, 3).join(", ")}{model.tags.length > 3 ? "…" : ""}</span>
            </>
          )}
        </div>
      </div>
      {ext && (
        <span className="font-mono text-[10px] bg-bg-3 text-fg-2 px-1.5 py-0.5 rounded">
          {ext}
        </span>
      )}
      <div className="flex items-center gap-1">
        <a
          href={api.getDownloadUrl(model)}
          onClick={(e) => e.stopPropagation()}
          className="w-7 h-7 grid place-items-center rounded-md text-fg-3 hover:bg-bg-3 hover:text-fg"
          aria-label="Download"
          title="Download"
        >
          <Download size={14} />
        </a>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onToggleSelection();
          }}
          className={`w-7 h-7 grid place-items-center rounded-md transition-colors ${
            isSelected
              ? "bg-accent text-accent-fg"
              : "text-fg-3 hover:bg-bg-3 hover:text-fg"
          }`}
          aria-label={isSelected ? "Unselect" : "Select"}
        >
          {isSelected ? <CheckSquare size={14} /> : <Square size={14} />}
        </button>
        <div className="relative">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onToggleMenu();
            }}
            className="w-7 h-7 grid place-items-center rounded-md text-fg-3 hover:bg-bg-3 hover:text-fg"
            aria-label="More actions"
          >
            <MoreHorizontal size={14} />
          </button>
          {menuOpen && (
            <div
              onClick={(e) => e.stopPropagation()}
              className="absolute right-0 top-full mt-1 min-w-[180px] bg-surface border border-border rounded-[10px] shadow-drawer p-1 flex flex-col gap-0.5 z-20"
              role="menu"
            >
              <button
                type="button"
                onClick={() => {
                  onClick();
                  onToggleMenu();
                }}
                className="text-left px-3 py-2 rounded-md text-[13px] text-fg hover:bg-bg-3 flex items-center gap-2.5"
              >
                <ExternalLink size={14} /> Open
              </button>
              <hr className="border-0 border-t border-border-soft my-1" />
              <button
                type="button"
                onClick={() => {
                  onDelete();
                  onToggleMenu();
                }}
                className="text-left px-3 py-2 rounded-md text-[13px] text-danger hover:bg-danger/15 flex items-center gap-2.5"
              >
                <Trash2 size={14} /> Delete
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default ModelList;
